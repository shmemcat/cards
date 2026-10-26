"""Explicit migration job; runtime containers only check readiness."""

from pathlib import Path
import sys

from alembic import command
from alembic.config import Config
from sqlalchemy import inspect, text
from sqlalchemy.exc import SQLAlchemyError

from cards_accounts.extensions import db

REVISION = "accounts_004"


def schema_ready():
    try:
        inspector = inspect(db.engine)
        required = {
            "users",
            "account_sessions",
            "password_reset_tokens",
            "account_deletion_requests",
            "account_id_sequence",
            "cards_accounts_alembic_version",
        }
        if not required <= set(inspector.get_table_names()):
            return False
        revision = db.session.execute(
            text("SELECT version_num FROM cards_accounts_alembic_version")
        ).scalar()
        # A compatible server is promoted before the additive migration. Keep
        # it ready on both revisions so migration and rollback remain possible.
        if revision == "accounts_001":
            return True
        if "account_turn_sound_options" not in inspector.get_table_names():
            return False
        if revision == "accounts_002":
            return True
        columns = {
            column["name"]
            for column in inspector.get_columns("account_turn_sound_options")
        }
        if not {"sound", "volume"} <= columns:
            return False
        if revision == "accounts_003":
            return True
        return revision == REVISION and inspector.has_table("account_card_backs")
    except SQLAlchemyError:
        db.session.rollback()
        return False


def upgrade_schema():
    configuration = Config()
    configuration.set_main_option(
        "script_location", str(Path(__file__).resolve().parent.parent / "migrations")
    )
    with db.engine.begin() as connection:
        if connection.dialect.name == "postgresql":
            connection.execute(text("SELECT pg_advisory_xact_lock(61349201001)"))
        configuration.attributes["connection"] = connection
        command.upgrade(configuration, "head")


if __name__ == "__main__":
    from cards_accounts import create_app

    app = create_app()
    with app.app_context():
        if sys.argv[1:] == ["upgrade"]:
            upgrade_schema()
        elif sys.argv[1:] == ["retry-deletions"]:
            from cards_accounts.deletions import retry_pending

            print("Completed cleanup jobs:", retry_pending())
        elif sys.argv[1:] == ["check"]:
            raise SystemExit(0 if schema_ready() else 1)
        else:
            raise SystemExit("Use upgrade, check, or retry-deletions")
