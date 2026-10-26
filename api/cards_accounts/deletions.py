"""Durable, retryable cleanup. Revoke first; remove the user only after both ACKs."""

from datetime import datetime, timedelta
import json
import threading
import uuid

from flask import current_app
from sqlalchemy.exc import IntegrityError
from sqlalchemy import inspect

from cards_accounts.account_contracts import DeletionResult
from cards_accounts.auth_utils import verify_password
from cards_accounts.extensions import db
from cards_accounts.game_client import call_game, GameUnavailable
from cards_accounts.models import (
    User,
    PasswordResetToken,
    TurnSoundOption,
    CardBackOption,
)


class DeletionRequest(db.Model):
    __tablename__ = "account_deletion_requests"
    id = db.Column(db.String(32), primary_key=True, default=lambda: uuid.uuid4().hex)
    # Deliberately not a FK: keep minimal cleanup receipts after removing users.
    user_id = db.Column(db.Integer, nullable=False, unique=True)
    status = db.Column(db.String(16), nullable=False, default="pending")
    acknowledgements = db.Column(db.Text, nullable=False, default="{}")
    created_at = db.Column(db.DateTime, nullable=False, default=datetime.utcnow)
    completed_at = db.Column(db.DateTime)
    retry_at = db.Column(db.DateTime, nullable=False, default=datetime.utcnow)
    lease_until = db.Column(db.DateTime)
    lease_owner = db.Column(db.String(32))
    attempts = db.Column(db.Integer, nullable=False, default=0)


def is_deleting(user_id):
    return DeletionRequest.query.filter_by(user_id=user_id).first() is not None


def delete_account(user_id, password):
    from cards_accounts.account_sessions import AccountSession

    if not isinstance(password, str) or not password:
        return DeletionResult(False, "Password required", 400)
    user = User.query.filter_by(id=user_id).with_for_update().first()
    if not user or not verify_password(password, user.password_hash):
        return DeletionResult(False, "Incorrect password", 401)
    job = DeletionRequest.query.filter_by(user_id=user_id).first()
    if job is None:
        job = DeletionRequest(user_id=user_id)
        db.session.add(job)
        user.auth_version += 1
        AccountSession.query.filter_by(user_id=user_id).delete(
            synchronize_session=False
        )
        PasswordResetToken.query.filter_by(user_id=user_id).delete(
            synchronize_session=False
        )
        user.verification_token, user.verification_expires = None, None
        try:
            db.session.commit()
        except IntegrityError:
            db.session.rollback()
            job = DeletionRequest.query.filter_by(user_id=user_id).one()
    job_id = job.id
    db.session.commit()  # No database lock or open read transaction during RPC.
    completed = process_deletion(job_id)
    return DeletionResult(
        completed,
        (
            "Account deleted"
            if completed
            else "Account deletion is processing. You are signed out; cleanup will retry automatically."
        ),
        200 if completed else 202,
    )


def process_deletion(job_id):
    owner = uuid.uuid4().hex
    now = datetime.utcnow()
    job = (
        DeletionRequest.query.populate_existing()
        .filter_by(id=job_id)
        .with_for_update()
        .one()
    )
    if job.status == "completed":
        db.session.commit()
        return True
    # Compare-and-set also works on SQLite, which ignores SELECT FOR UPDATE.
    claimed = DeletionRequest.query.filter(
        DeletionRequest.id == job_id,
        DeletionRequest.status == "pending",
        db.or_(
            DeletionRequest.lease_until.is_(None), DeletionRequest.lease_until <= now
        ),
    ).update(
        {
            DeletionRequest.lease_until: now + timedelta(seconds=30),
            DeletionRequest.lease_owner: owner,
            DeletionRequest.attempts: DeletionRequest.attempts + 1,
        },
        synchronize_session=False,
    )
    db.session.commit()
    if claimed != 1:
        return False
    job = DeletionRequest.query.populate_existing().filter_by(id=job_id).one()
    user_id, acknowledgements = job.user_id, json.loads(job.acknowledgements)
    db.session.commit()
    games = (
        "hearts",
        "euchre",
        *(["golf"] if "golf" in current_app.config["GAME_SERVICES"] else []),
        *(["handandfoot"] if "handandfoot" in current_app.config["GAME_SERVICES"] else []),
    )
    for game in games:
        if acknowledgements.get(game):
            continue
        try:
            result = call_game(
                game, "delete-user", {"user_id": user_id, "request_id": job_id}
            )
            acknowledged = (
                result.get("deleted") is True and result.get("request_id") == job_id
            )
        except GameUnavailable:
            acknowledged = False
        if acknowledged:
            job = (
                DeletionRequest.query.populate_existing()
                .filter_by(id=job_id)
                .with_for_update()
                .one()
            )
            if job.lease_owner != owner:
                db.session.commit()
                return job.status == "completed"
            acknowledgements = json.loads(job.acknowledgements)
            acknowledgements[game] = True
            job.acknowledgements = json.dumps(acknowledgements)
            db.session.commit()
    job = (
        DeletionRequest.query.populate_existing()
        .filter_by(id=job_id)
        .with_for_update()
        .one()
    )
    if job.status == "completed":
        db.session.commit()
        return True
    if job.lease_owner != owner:
        db.session.commit()
        return False
    acknowledgements = json.loads(job.acknowledgements)
    if all(acknowledgements.get(game) for game in games):
        try:
            from cards_accounts.account_sessions import AccountSession

            AccountSession.query.filter_by(user_id=user_id).delete(
                synchronize_session=False
            )
            PasswordResetToken.query.filter_by(user_id=user_id).delete(
                synchronize_session=False
            )
            if inspect(db.engine).has_table("account_turn_sound_options"):
                TurnSoundOption.query.filter_by(user_id=user_id).delete(
                    synchronize_session=False
                )
            if inspect(db.engine).has_table("account_card_backs"):
                CardBackOption.query.filter_by(user_id=user_id).delete(
                    synchronize_session=False
                )
            User.query.filter_by(id=user_id).delete(synchronize_session="fetch")
            job.status, job.completed_at = "completed", datetime.utcnow()
            job.lease_owner, job.lease_until = None, None
            db.session.commit()
            return True
        except IntegrityError:
            # An unacknowledged schema dependency must never produce success.
            db.session.rollback()
            current_app.logger.error("Account deletion awaits database cleanup")
    job = (
        DeletionRequest.query.populate_existing()
        .filter_by(id=job_id)
        .with_for_update()
        .one()
    )
    if job.lease_owner == owner:
        job.lease_until, job.lease_owner = None, None
        job.retry_at = datetime.utcnow() + timedelta(
            seconds=min(300, 5 * 2 ** min(job.attempts, 6))
        )
    db.session.commit()
    return False


def retry_pending():
    now = datetime.utcnow()
    ids = [
        row.id
        for row in DeletionRequest.query.filter(
            DeletionRequest.status == "pending",
            DeletionRequest.retry_at <= now,
            db.or_(
                DeletionRequest.lease_until.is_(None),
                DeletionRequest.lease_until <= now,
            ),
        ).limit(20)
    ]
    db.session.remove()
    return sum(process_deletion(job_id) for job_id in ids)


def start_worker(app):
    stop = threading.Event()

    def run():
        while not stop.is_set():
            try:
                with app.app_context():
                    retry_pending()
            except Exception:
                app.logger.error("Account cleanup worker will retry")
            stop.wait(5)

    thread = threading.Thread(target=run, name="cards-account-cleanup", daemon=True)
    thread.start()
    app.extensions["deletion_worker"] = (thread, stop)
