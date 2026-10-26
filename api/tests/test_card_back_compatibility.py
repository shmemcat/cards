from sqlalchemy import text

from cards_accounts.extensions import db
from cards_accounts.schema import schema_ready


def test_ready_before_and_after_additive_card_back_migration(app):
    with app.app_context():
        assert schema_ready()
        with db.engine.begin() as connection:
            connection.execute(text("UPDATE cards_accounts_alembic_version SET version_num='accounts_004'"))
        assert not schema_ready()
        with db.engine.begin() as connection:
            connection.execute(text("CREATE TABLE account_card_backs (user_id INTEGER, game VARCHAR(16), design VARCHAR(64))"))
        assert schema_ready()
