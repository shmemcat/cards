"""Shared login and email recovery backed by the existing Hearts users table."""

import json
import os
import secrets
from concurrent.futures import ThreadPoolExecutor
from threading import BoundedSemaphore
from datetime import datetime, timedelta
from pathlib import Path
from urllib.parse import urlencode, urlsplit

from flask import Blueprint, current_app, jsonify, request
from sqlalchemy.exc import IntegrityError
from sqlalchemy import inspect
from cards_accounts.deletions import is_deleting

from cards_accounts.account_sessions import (
    AccountSession,
    current_session,
    new_session,
    session_response,
    session_user,
)
from cards_accounts.account_http import body, no_store, protect_account
from cards_accounts.auth_routes import (
    _validate_email,
    _validate_password,
    _validate_username,
)
from cards_accounts.auth_routes import VALID_PROFILE_ICONS, delete_user_account
from cards_accounts.auth_utils import hash_password, verify_password
from cards_accounts.email_templates import (
    password_reset_email_html,
    verification_email_html,
)
from cards_accounts.email_utils import _send, hash_token
from cards_accounts.extensions import db, limiter
from cards_accounts.models import PasswordResetToken, User
from cards_accounts.card_backs import CARD_BACK_DESIGNS
from cards_accounts.account_security import change_email, reset_password_with_token

account_bp = Blueprint("cards_account", __name__, url_prefix="/account")
_dummy_password_hash = None
_mail_workers = ThreadPoolExecutor(max_workers=2, thread_name_prefix="cards-mail")
_mail_slots = BoundedSemaphore(32)


def field(data, name):
    value = data.get(name, "")
    return value if isinstance(value, str) else ""


def send_account_email(user, token, kind):
    base = current_app.config["CARDS_PUBLIC_URL"].rstrip("/")
    url = f"{base}/user/?{urlencode({'view': kind, 'token': token})}"
    html = (
        verification_email_html(url)
        if kind == "verify"
        else password_reset_email_html(url)
    )
    subject = (
        "Verify your Cards account" if kind == "verify" else "Reset your Cards password"
    )
    if current_app.config.get("CARDS_EMAIL_TRANSPORT") == "file":
        if urlsplit(base).hostname not in {"localhost", "127.0.0.1"}:
            raise RuntimeError(
                "File email delivery is only allowed for local development."
            )
        outbox = Path(current_app.config["CARDS_EMAIL_OUTBOX"])
        outbox.mkdir(parents=True, exist_ok=True)
        name = outbox / f"{datetime.utcnow():%Y%m%d-%H%M%S}-{secrets.token_hex(5)}.json"
        # Tokens belong only in the local mail sandbox; never in application logs or API responses.
        descriptor = os.open(str(name), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as mail:
            json.dump(
                {"to": user.email, "subject": subject, "url": url, "html": html}, mail
            )
        return True
    # Keep provider latency out of recovery responses, so email existence cannot
    # be inferred from a slow SMTP request. Bound queued work as well as workers.
    if not _mail_slots.acquire(blocking=False):
        current_app.logger.error("Cards email queue is full; request a new link later.")
        return False
    app, address = current_app._get_current_object(), user.email

    def deliver():
        try:
            with app.app_context():
                _send(address, subject, html, sender_name="Cards")
        finally:
            _mail_slots.release()

    try:
        _mail_workers.submit(deliver)
    except RuntimeError:
        _mail_slots.release()
        app.logger.exception("Unable to queue Cards email")
        return False
    return True


account_bp.before_request(protect_account)
account_bp.after_request(no_store)


@account_bp.get("/session")
@limiter.limit("120 per minute")
def get_session():
    return session_response()


@account_bp.post("/login")
@limiter.limit("10 per minute;60 per hour")
def login():
    global _dummy_password_hash
    data = body()
    username, password = field(data, "username").strip(), field(data, "password")
    if not username or not password or len(username) > 255 or len(password) > 1024:
        return jsonify(error="Check your username or email and password."), 401
    user = User.query.filter_by(username=username).first()
    if user is None and _validate_email(username):
        user = User.query.filter_by(email=username.lower()).first()
    if _dummy_password_hash is None:
        _dummy_password_hash = hash_password(secrets.token_urlsafe(32))
    try:
        correct = verify_password(
            password, user.password_hash if user else _dummy_password_hash
        )
    except Exception:
        correct = False
    if not user or not correct:
        return jsonify(error="Check your username or email and password."), 401
    from cards_accounts.deletions import is_deleting

    if is_deleting(user.id):
        return (
            jsonify(error="Account deletion is processing.", code="DELETION_PENDING"),
            403,
        )
    if not user.email_verified:
        return (
            jsonify(
                error="Verify your email before signing in.", code="EMAIL_NOT_VERIFIED"
            ),
            403,
        )
    return session_response(rotate=True, user=user)


@account_bp.post("/logout")
def logout():
    return session_response(rotate=True)


@account_bp.post("/profile")
@limiter.limit("30 per minute")
def update_account_profile():
    user = session_user()
    if not user:
        return jsonify(error="Sign in to customize your profile."), 401
    data = body()
    if not any(
        key in data for key in ("profile_icon", "email", "turn_sound", "card_back")
    ):
        return jsonify(error="No changes provided."), 400
    card_back = data.get("card_back")
    if "card_back" in data and (
        not isinstance(card_back, dict)
        or not ({"design", "display"} & card_back.keys())
        or bool(card_back.keys() - {"game", "design", "display"})
        or not isinstance(card_back.get("game"), str)
        or card_back["game"] not in CARD_BACK_DESIGNS
        or (
            "design" in card_back
            and (
                not isinstance(card_back["design"], str)
                or card_back["design"] not in CARD_BACK_DESIGNS[card_back["game"]]
            )
        )
        or (
            "display" in card_back
            and card_back["display"] not in ("uniform", "players")
        )
    ):
        return jsonify(error="Choose a valid card back."), 400
    inspector = inspect(db.engine)
    card_back_table = inspector.has_table("account_card_backs")
    if card_back is not None and (
        not card_back_table
        or (
            "display" in card_back
            and "display_mode"
            not in {
                column["name"] for column in inspector.get_columns("account_card_backs")
            }
        )
    ):
        return (
            jsonify(
                error="Card back settings are being updated. Please try again shortly."
            ),
            503,
        )
    turn_sound = data.get("turn_sound")
    if "turn_sound" in data and (
        not isinstance(turn_sound, dict)
        or turn_sound.get("game") not in ("golf", "euchre", "hearts")
        or not ({"enabled", "sound", "volume"} & turn_sound.keys())
        or bool(turn_sound.keys() - {"game", "enabled", "sound", "volume"})
        or ("enabled" in turn_sound and type(turn_sound["enabled"]) is not bool)
        or (
            "sound" in turn_sound
            and turn_sound["sound"] not in ("pop", "chime", "ding", "notification")
        )
        or (
            "volume" in turn_sound
            and (
                type(turn_sound["volume"]) not in (int, float)
                or not 0 <= turn_sound["volume"] <= 1
            )
        )
    ):
        return (
            jsonify(error="Choose a valid game, indicator sound, and volume."),
            400,
        )
    icon = field(data, "profile_icon").strip()
    if "profile_icon" in data and icon not in VALID_PROFILE_ICONS:
        return jsonify(error="Choose a valid profile icon."), 400
    email = field(data, "email").strip().lower()
    if "email" in data and (len(email) > 255 or not _validate_email(email)):
        return jsonify(error="Enter a valid email address."), 400
    if "email" in data:
        existing = User.query.filter_by(email=email).first()
        if existing and existing.id != user.id:
            return jsonify(error="That email is already registered."), 409
    email_changed = "email" in data and email != user.email
    if "profile_icon" in data:
        user.profile_icon = icon
    if card_back is not None:
        User.query.filter_by(id=user.id).with_for_update().one()
        from sqlalchemy import MetaData, Table, select

        table = Table(
            "account_card_backs", MetaData(), autoload_with=db.session.connection()
        )
        condition = (table.c.user_id == user.id) & (table.c.game == card_back["game"])
        values = {
            column: card_back[key]
            for key, column in (("design", "design"), ("display", "display_mode"))
            if key in card_back
        }
        if db.session.execute(select(table.c.user_id).where(condition)).first():
            db.session.execute(table.update().where(condition).values(**values))
        else:
            db.session.execute(
                table.insert().values(user_id=user.id, game=card_back["game"], **values)
            )
    if turn_sound is not None:
        inspector = inspect(db.engine)
        table_available = inspector.has_table("account_turn_sound_options")
        columns = (
            {
                column["name"]
                for column in inspector.get_columns("account_turn_sound_options")
            }
            if table_available
            else set()
        )
        if not table_available or (
            {"sound", "volume"} & turn_sound.keys()
            and not {"sound", "volume"} <= columns
        ):
            return (
                jsonify(
                    error="Turn indicator settings are being updated. Please try again shortly."
                ),
                503,
            )
        # Serialize first-time option creation for concurrent tabs on PostgreSQL.
        User.query.filter_by(id=user.id).with_for_update().one()
        # Reflect the adopted columns so old enabled-only clients also work
        # during the compatible-server stage of the additive upgrade.
        from sqlalchemy import MetaData, Table, select

        table = Table(
            "account_turn_sound_options",
            MetaData(),
            autoload_with=db.session.connection(),
        )
        condition = (table.c.user_id == user.id) & (table.c.game == turn_sound["game"])
        values = {
            key: turn_sound[key]
            for key in ("enabled", "sound", "volume")
            if key in turn_sound
        }
        if db.session.execute(select(table.c.user_id).where(condition)).first():
            db.session.execute(table.update().where(condition).values(**values))
        else:
            db.session.execute(
                table.insert().values(
                    user_id=user.id, game=turn_sound["game"], **values
                )
            )
    token = None
    if email_changed:
        current = current_session()
        token = change_email(user, email, keep_session=current.token_hash)
    try:
        db.session.commit()
    except IntegrityError:
        db.session.rollback()
        return jsonify(error="That email is already registered."), 409
    if token:
        send_account_email(user, token, "verify")
    response = session_response(rotate=email_changed)
    payload = response.get_json()
    payload["message"] = (
        "Verification email sent. Verify your new address, then sign in again."
        if email_changed
        else "Profile saved."
    )
    response.set_data(current_app.json.dumps(payload))
    return response


@account_bp.post("/delete")
@limiter.limit("3 per minute")
def delete_shared_account():
    if not session_user():
        return jsonify(error="Sign in to delete your account."), 401
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        data = {}
    password = field(data, "password")
    if not password or len(password) > 1024:
        return jsonify(error="Please enter your password."), 400
    # Revoke credentials, then wait for durable cleanup acknowledgements.
    response = current_app.make_response(delete_user_account(session_user(), password))
    if response.status_code not in {200, 202}:
        return response
    request.environ["cards.session"] = None
    result = session_response(rotate=True)
    if response.status_code == 202:
        payload = result.get_json()
        payload.update(message=response.get_json()["message"], code="DELETION_PENDING")
        result.set_data(current_app.json.dumps(payload))
        result.status_code = 202
    return result


@account_bp.post("/register")
@limiter.limit("5 per minute;10 per hour")
def register():
    data = body()
    username, email, password = (
        field(data, "username").strip(),
        field(data, "email").strip().lower(),
        field(data, "password"),
    )
    ok, error = _validate_username(username)
    if not ok:
        return jsonify(error=error), 400
    if not _validate_email(email) or len(email) > 255:
        return jsonify(error="Enter a valid email address."), 400
    ok, error = _validate_password(password)
    if not ok or len(password) > 1024:
        return jsonify(error=error or "Password is too long."), 400
    token = secrets.token_urlsafe(32)
    user = User(
        username=username,
        email=email,
        password_hash=hash_password(password),
        email_verified=False,
        verification_token=hash_token(token),
        verification_expires=datetime.utcnow() + timedelta(hours=24),
    )
    try:
        db.session.add(user)
        db.session.commit()
    except IntegrityError:
        db.session.rollback()
        return jsonify(error="That username or email is already registered."), 409
    send_account_email(user, token, "verify")
    return jsonify(message="Check your email to verify your account."), 201


@account_bp.post("/verify-email")
@limiter.limit("10 per minute")
def verify_email():
    token = field(body(), "token").strip()
    if not token or len(token) > 256:
        return jsonify(error="This verification link is invalid or expired."), 400
    # Also accept existing Hearts verification links during the account transition.
    user = (
        User.query.filter(User.verification_token.in_([hash_token(token), token]))
        .with_for_update(of=User)
        .first()
    )
    if (
        not user
        or is_deleting(user.id)
        or not user.verification_expires
        or user.verification_expires <= datetime.utcnow()
    ):
        return jsonify(error="This verification link is invalid or expired."), 400
    user.email_verified, user.verification_token, user.verification_expires = (
        True,
        None,
        None,
    )
    db.session.commit()
    return jsonify(message="Email verified. You can sign in now.")


@account_bp.post("/resend-verification")
@limiter.limit("3 per minute;5 per hour")
def resend_verification():
    email = field(body(), "email").strip().lower()
    if not _validate_email(email) or len(email) > 255:
        return jsonify(error="Enter a valid email address."), 400
    user = User.query.filter_by(email=email).first()
    if user and not user.email_verified and not is_deleting(user.id):
        token = secrets.token_urlsafe(32)
        user.verification_token, user.verification_expires = hash_token(
            token
        ), datetime.utcnow() + timedelta(hours=24)
        db.session.commit()
        send_account_email(user, token, "verify")
    return jsonify(
        message="If that account needs verification, a new link has been sent."
    )


@account_bp.post("/forgot-password")
@limiter.limit("3 per minute;5 per hour")
def forgot_password():
    email = field(body(), "email").strip().lower()
    if not _validate_email(email) or len(email) > 255:
        return jsonify(error="Enter a valid email address."), 400
    user = User.query.filter_by(email=email).first()
    if user and not is_deleting(user.id):
        token = secrets.token_urlsafe(32)
        # Keep previous requests valid until one reset is completed, avoiding reset-link denial of service.
        db.session.add(
            PasswordResetToken(
                user_id=user.id,
                token_hash=hash_token(token),
                expires_at=datetime.utcnow() + timedelta(hours=1),
            )
        )
        db.session.commit()
        send_account_email(user, token, "reset")
    return jsonify(
        message="If that email is registered, a password reset link has been sent."
    )


@account_bp.post("/reset-password")
@limiter.limit("10 per minute;60 per hour")
def reset_password():
    data = body()
    token, password = field(data, "token").strip(), field(data, "password")
    ok, error = _validate_password(password)
    if not ok or len(password) > 1024:
        return jsonify(error=error or "Password is too long."), 400
    if not token or len(token) > 256:
        return jsonify(error="This reset link is invalid or expired."), 400
    if not reset_password_with_token(token, password):
        return jsonify(error="This reset link is invalid or expired."), 400
    return jsonify(message="Password updated. Sign in with your new password.")
