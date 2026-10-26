import secrets
from datetime import datetime, timedelta
from cards_accounts.extensions import db
from cards_accounts.game_client import profile_preferences, preferences_available
from sqlalchemy import event, inspect, select, update


class User(db.Model):
    __tablename__ = "users"

    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(64), unique=True, nullable=False, index=True)
    email = db.Column(db.String(255), unique=True, nullable=False, index=True)
    password_hash = db.Column(db.String(255), nullable=False)
    auth_version = db.Column(db.Integer, nullable=False, default=0, server_default="0")
    profile_icon = db.Column(
        db.String(64), default="user", nullable=False, server_default="user"
    )
    email_verified = db.Column(db.Boolean, default=False, nullable=False)
    verification_token = db.Column(db.String(64), unique=True, index=True)
    verification_expires = db.Column(db.DateTime)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    def to_dict(self):
        card_backs = {"golf": "argyle"}
        turn_sound = dict.fromkeys(("golf", "euchre", "hearts"), False)
        turn_sound_options = {
            game: {"sound": "pop", "volume": 0.15} for game in turn_sound
        }
        inspector = inspect(db.engine)
        if inspector.has_table("account_card_backs"):
            for choice in CardBackOption.query.filter_by(user_id=self.id):
                card_backs[choice.game] = choice.design
        if inspector.has_table("account_turn_sound_options"):
            # Explicit columns keep existing sessions usable before accounts_003.
            columns = {
                column["name"]
                for column in inspector.get_columns("account_turn_sound_options")
            }
            fields = [TurnSoundOption.game, TurnSoundOption.enabled]
            if {"sound", "volume"} <= columns:
                fields += [TurnSoundOption.sound, TurnSoundOption.volume]
            rows = db.session.execute(
                select(*fields).where(TurnSoundOption.user_id == self.id)
            ).mappings()
            for row in rows:
                if row["game"] in turn_sound:
                    turn_sound[row["game"]] = row["enabled"]
                    if "sound" in row:
                        turn_sound_options[row["game"]] = {
                            "sound": row["sound"],
                            "volume": row["volume"],
                        }
        return {
            "id": self.id,
            "username": self.username,
            "email": self.email,
            "name": self.username,
            "email_verified": self.email_verified,
            "profile_icon": self.profile_icon,
            "turn_sound": turn_sound,
            "turn_sound_options": turn_sound_options,
            "card_backs": card_backs,
            "preferences": profile_preferences(self.id),
            "preferences_available": preferences_available(self.id),
        }

    def set_verification_token(self, expires_hours=24):
        from cards_accounts.email_utils import hash_token

        token = secrets.token_urlsafe(32)
        self.verification_token = hash_token(token)
        self.verification_expires = datetime.utcnow() + timedelta(hours=expires_hours)
        return token


class TurnSoundOption(db.Model):
    __tablename__ = "account_turn_sound_options"

    user_id = db.Column(
        db.Integer, db.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    game = db.Column(db.String(16), primary_key=True)
    enabled = db.Column(db.Boolean, nullable=False, default=False, server_default="0")
    sound = db.Column(
        db.String(24), nullable=False, default="pop", server_default="pop"
    )
    volume = db.Column(db.Float, nullable=False, default=0.15, server_default="0.15")
    user = db.relationship(
        "User", backref=db.backref("turn_sound_options", lazy="select")
    )


class CardBackOption(db.Model):
    __tablename__ = "account_card_backs"

    user_id = db.Column(
        db.Integer, db.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    game = db.Column(db.String(16), primary_key=True)
    design = db.Column(
        db.String(64), nullable=False, default="argyle", server_default="argyle"
    )


class PasswordResetToken(db.Model):
    __tablename__ = "password_reset_tokens"

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False)
    token_hash = db.Column(db.String(255), nullable=False, index=True)
    expires_at = db.Column(db.DateTime, nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    user = db.relationship("User", backref=db.backref("reset_tokens", lazy="dynamic"))


class AccountIdSequence(db.Model):
    __tablename__ = "account_id_sequence"
    id = db.Column(db.Integer, primary_key=True)
    next_id = db.Column(db.BigInteger, nullable=False)


@event.listens_for(User, "before_insert")
def sqlite_account_id(mapper, connection, user):
    if connection.dialect.name != "sqlite":
        return
    sequence = AccountIdSequence.__table__
    if user.id is None:
        user.id = connection.execute(
            update(sequence)
            .where(sequence.c.id == 1)
            .values(next_id=sequence.c.next_id + 1)
            .returning(sequence.c.next_id - 1)
        ).scalar_one()
    else:
        connection.execute(
            update(sequence)
            .where(sequence.c.id == 1, sequence.c.next_id <= user.id)
            .values(next_id=user.id + 1)
        )
