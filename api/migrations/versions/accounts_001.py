"""Preserve legacy account tables and add durable deletion coordination."""

from alembic import op
from sqlalchemy import inspect, text
import json

revision = "accounts_001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade():
    from cards_accounts.models import User, PasswordResetToken, AccountIdSequence
    from cards_accounts.account_sessions import AccountSession
    from cards_accounts.deletions import DeletionRequest

    connection = op.get_bind()
    inspector = inspect(connection)
    existing = set(inspector.get_table_names())
    if existing & {
        "active_games",
        "user_stats",
        "user_preferences",
        "difficulty_stats",
        "game_results",
        "euchre_tables",
        "euchre_game_results",
    }:
        if (
            "alembic_version" not in existing
            or connection.execute(
                text("SELECT version_num FROM alembic_version")
            ).scalar()
            != "019"
        ):
            raise RuntimeError(
                "Upgrade and verify the legacy bootstrap through 019 before migrating accounts"
            )
    for model in (User, AccountSession, PasswordResetToken):
        table = model.__table__
        if table.name in existing:
            actual = {column["name"] for column in inspector.get_columns(table.name)}
            if not set(table.columns.keys()) <= actual:
                raise RuntimeError(
                    "Existing account schema is incompatible; no records were replaced"
                )
        else:
            table.create(connection)
    DeletionRequest.__table__.create(connection, checkfirst=True)
    AccountIdSequence.__table__.create(connection, checkfirst=True)
    if (
        connection.execute(
            text("SELECT next_id FROM account_id_sequence WHERE id = 1")
        ).scalar()
        is None
    ):
        highest = connection.execute(text("SELECT MAX(id) FROM users")).scalar() or 0
        # Legacy SQLite can recycle a deleted integer primary key. Seed from
        # historical references as well; subsequent allocation is monotonic.
        for name in (
            "user_stats",
            "user_preferences",
            "difficulty_stats",
            "game_results",
            "euchre_game_results",
            "active_games",
        ):
            if name in existing:
                highest = max(
                    highest,
                    connection.execute(
                        text(f"SELECT MAX(user_id) FROM {name}")
                    ).scalar()
                    or 0,
                )
        if "euchre_tables" in existing:
            for (raw,) in connection.execute(
                text("SELECT snapshot FROM euchre_tables")
            ):
                snapshot = json.loads(raw)
                members = [value for value in snapshot.get("seats", []) if value]
                members += list(snapshot.get("unseated", {}).values()) + snapshot.get(
                    "participants", []
                )
                highest = max(
                    [highest]
                    + [
                        value["userId"]
                        for value in members
                        if type(value.get("userId")) is int
                    ]
                )
        connection.execute(
            AccountIdSequence.__table__.insert().values(id=1, next_id=highest + 1)
        )


def downgrade():
    raise RuntimeError(
        "Account cleanup history is retained; use an additive forward migration"
    )
