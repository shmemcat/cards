"""Schema ownership and legacy-preservation checks, without a game package."""

import subprocess
import sys
from datetime import datetime

import pytest
from sqlalchemy import inspect, text

from cards_accounts import create_app
from cards_accounts.extensions import db
from cards_accounts.models import User
from cards_accounts.schema import schema_ready, upgrade_schema


@pytest.mark.parametrize("legacy", [None, "019", "018"])
def test_fresh_and_legacy_migration_preserves_records(tmp_path, legacy):
    app = create_app(
        {"SQLALCHEMY_DATABASE_URI": "sqlite:///" + str(tmp_path / "schema.db")}
    )
    with app.app_context():
        if legacy:
            User.__table__.create(db.engine)
            with db.engine.begin() as connection:
                connection.execute(text("CREATE TABLE active_games (user_id INTEGER)"))
                connection.execute(text("INSERT INTO active_games VALUES (900)"))
                connection.execute(
                    text("CREATE TABLE alembic_version (version_num VARCHAR(32))")
                )
                connection.execute(
                    text("INSERT INTO alembic_version VALUES (:version)"),
                    {"version": legacy},
                )
                connection.execute(
                    User.__table__.insert().values(
                        id=42,
                        username="preserved",
                        email="preserved@example.test",
                        password_hash="existing-password-hash",
                        auth_version=9,
                        email_verified=True,
                        profile_icon="cat",
                        verification_token="legacy-link",
                        created_at=datetime(2020, 1, 1),
                    )
                )
        if legacy == "018":
            with pytest.raises(RuntimeError, match="019"):
                upgrade_schema()
            assert not schema_ready()
        else:
            upgrade_schema()
            upgrade_schema()
            assert schema_ready()
            if legacy:
                user = db.session.get(User, 42)
                assert (
                    user.password_hash,
                    user.auth_version,
                    user.verification_token,
                    user.profile_icon,
                ) == ("existing-password-hash", 9, "legacy-link", "cat")
                assert user.created_at == datetime(2020, 1, 1)
                assert (
                    db.session.execute(
                        text("SELECT next_id FROM account_id_sequence")
                    ).scalar()
                    == 901
                )
                assert (
                    db.session.execute(
                        text("SELECT version_num FROM alembic_version")
                    ).scalar()
                    == "019"
                )
            else:
                assert "active_games" not in inspect(db.engine).get_table_names()
        db.session.remove()
        db.engine.dispose()


def test_independent_imports_exclude_game_modules():
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            "import sys; from cards_accounts import create_app; create_app(); assert not any(x == 'hearts' or x.startswith('hearts.') for x in sys.modules)",
        ],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr


def test_turn_sound_upgrade_preserves_existing_accounts(app, user):
    with app.app_context():
        with db.engine.begin() as connection:
            connection.execute(text("DROP TABLE account_turn_sound_options"))
            connection.execute(
                text(
                    "UPDATE cards_accounts_alembic_version SET version_num = 'accounts_001'"
                )
            )
        assert schema_ready()
        upgrade_schema()
        assert schema_ready()
        existing = db.session.get(User, user)
        assert existing.username == "existing_player"
        assert existing.profile_icon == "cat"
        assert existing.to_dict()["turn_sound"] == dict.fromkeys(
            ("golf", "euchre", "hearts"), False
        )


def test_compatible_server_keeps_accounts_usable_before_migration(app, client, user):
    from tests.conftest import post, sign_in

    with app.app_context():
        with db.engine.begin() as connection:
            connection.execute(text("DROP TABLE account_turn_sound_options"))
            connection.execute(
                text(
                    "UPDATE cards_accounts_alembic_version SET version_num = 'accounts_001'"
                )
            )
    session = sign_in(client)
    assert session.status_code == 200
    assert session.json["user"]["turn_sound"] == dict.fromkeys(
        ("golf", "euchre", "hearts"), False
    )
    assert post(client, "profile", {"profile_icon": "sparkles"}).status_code == 200
    assert (
        post(
            client, "profile", {"turn_sound": {"game": "golf", "enabled": True}}
        ).status_code
        == 503
    )
    with app.app_context():
        upgrade_schema()
    assert (
        post(client, "profile", {"turn_sound": {"game": "golf", "enabled": True}}).json[
            "user"
        ]["turn_sound"]["golf"]
        is True
    )
