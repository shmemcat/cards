"""The account service is the only owner of credential validation."""

import jwt
from flask import current_app, request

from cards_accounts import account_sessions
from cards_accounts.account_contracts import AccountIdentity, AccountSession
from cards_accounts.extensions import db
from cards_accounts.models import CardBackOption, User
from sqlalchemy import inspect, select


def identity(user, golf_card_back=None):
    if user is None:
        return None
    from cards_accounts.deletions import is_deleting

    if is_deleting(user.id):
        return None
    if golf_card_back is None:
        golf_card_back = "argyle"
        if inspect(db.engine).has_table("account_card_backs"):
            golf_card_back = (
                db.session.execute(
                    select(CardBackOption.design).where(
                        CardBackOption.user_id == user.id, CardBackOption.game == "golf"
                    )
                ).scalar()
                or "argyle"
            )
    return AccountIdentity(
        user.id, user.username, user.profile_icon, user.email_verified, golf_card_back
    )


class LocalAccounts:
    def session(self):
        row = account_sessions.current_session()
        return AccountSession(row.csrf_token) if row else None

    def cookie_user(self):
        return identity(account_sessions.session_user())

    def legacy_user(self, token):
        secret = current_app.config.get("JWT_SECRET")
        if not secret:
            return None
        try:
            payload = jwt.decode(token, secret, algorithms=["HS256"])
            user = db.session.get(User, int(payload.get("sub")))
            return (
                identity(user)
                if user and payload.get("av", 0) == user.auth_version
                else None
            )
        except (jwt.InvalidTokenError, ValueError, TypeError, OverflowError):
            return None

    def public_profiles(self, ids):
        ids = set(ids)
        card_backs = {}
        if ids and inspect(db.engine).has_table("account_card_backs"):
            card_backs = dict(
                db.session.execute(
                    select(CardBackOption.user_id, CardBackOption.design).where(
                        CardBackOption.user_id.in_(ids), CardBackOption.game == "golf"
                    )
                ).all()
            )
        return {
            row.id: value
            for row in User.query.filter(User.id.in_(ids))
            if (value := identity(row, card_backs.get(row.id, "argyle"))) is not None
        }

    def valid_origin(self):
        return account_sessions.valid_origin()

    def valid_csrf(self):
        return account_sessions.valid_csrf(account_sessions.current_session())

    def refresh(self):
        request.environ.pop("cards.session", None)

    def delete_account(self, user_id, password):
        from cards_accounts.deletions import delete_account

        return delete_account(user_id, password)
