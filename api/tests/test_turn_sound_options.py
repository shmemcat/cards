import pytest
from sqlalchemy import text

from cards_accounts.extensions import db
from cards_accounts.models import TurnSoundOption
from cards_accounts.schema import schema_ready, upgrade_schema
from tests.conftest import post, sign_in


@pytest.mark.parametrize("game", ["golf", "hearts", "euchre"])
def test_sound_and_volume_are_per_game_and_do_not_enable_alerts(
    client, user, app, game
):
    session = sign_in(client).json["user"]
    assert session["turn_sound_options"][game] == {"sound": "pop", "volume": 0.15}
    response = post(
        client,
        "profile",
        {"turn_sound": {"game": game, "sound": "notification", "volume": 0.9}},
    )
    assert response.status_code == 200
    assert not any(response.json["user"]["turn_sound"].values())
    assert response.json["user"]["turn_sound_options"][game] == {
        "sound": "notification",
        "volume": 0.9,
    }
    for other in ("golf", "hearts", "euchre"):
        if other != game:
            assert response.json["user"]["turn_sound_options"][other] == {
                "sound": "pop",
                "volume": 0.15,
            }
    post(client, "logout")
    assert sign_in(client).json["user"]["turn_sound_options"][game] == {
        "sound": "notification",
        "volume": 0.9,
    }
    post(client, "profile", {"turn_sound": {"game": game, "enabled": True}})
    response = post(client, "profile", {"turn_sound": {"game": game, "enabled": False}})
    assert response.json["user"]["turn_sound_options"][game] == {
        "sound": "notification",
        "volume": 0.9,
    }
    with app.app_context():
        assert TurnSoundOption.query.one().enabled is False


@pytest.mark.parametrize(
    "patch",
    [
        {"sound": "sirens"},
        {"sound": None},
        {"volume": -1},
        {"volume": 1.1},
        {"volume": "0.8"},
        {"volume": True},
        {"volume": None},
        {"volume": float("nan")},
        {"volume": float("inf")},
        {"enabled": 1},
        {"sound": "ding", "other": True},
        {},
    ],
)
def test_rejects_invalid_values_without_changing_other_preferences(client, user, patch):
    sign_in(client)
    assert (
        post(client, "profile", {"turn_sound": {"game": "golf", **patch}}).status_code
        == 400
    )
    state = client.get("/account/session").json["user"]
    assert state["turn_sound_options"]["golf"] == {"sound": "pop", "volume": 0.15}
    assert state["turn_sound"]["golf"] is False


def test_additive_migration_preserves_old_opt_in_and_session(client, user, app):
    sign_in(client)
    post(client, "profile", {"turn_sound": {"game": "hearts", "enabled": True}})
    with app.app_context():
        with db.engine.begin() as connection:
            connection.execute(
                text("ALTER TABLE account_turn_sound_options DROP COLUMN sound")
            )
            connection.execute(
                text("ALTER TABLE account_turn_sound_options DROP COLUMN volume")
            )
            connection.execute(
                text(
                    "UPDATE cards_accounts_alembic_version SET version_num='accounts_002'"
                )
            )
        assert schema_ready()
    assert client.get("/account/session").json["user"]["turn_sound"]["hearts"] is True
    assert (
        post(
            client, "profile", {"turn_sound": {"game": "golf", "enabled": True}}
        ).status_code
        == 200
    )
    assert (
        post(
            client, "profile", {"turn_sound": {"game": "golf", "sound": "ding"}}
        ).status_code
        == 503
    )
    with app.app_context():
        upgrade_schema()
        upgrade_schema()
        assert schema_ready()
    state = client.get("/account/session").json["user"]
    assert state["id"] == str(user)
    assert state["turn_sound"] == {"golf": True, "euchre": False, "hearts": True}
    assert state["turn_sound_options"]["hearts"] == {"sound": "pop", "volume": 0.15}
    response = post(
        client,
        "profile",
        {"turn_sound": {"game": "golf", "sound": "ding", "volume": 0}},
    )
    assert response.status_code == 200
    assert response.json["user"]["turn_sound_options"]["golf"] == {
        "sound": "ding",
        "volume": 0,
    }


def test_combined_profile_change_and_sound_save_are_atomic(client, user):
    sign_in(client)
    response = post(
        client,
        "profile",
        {
            "profile_icon": "sparkles",
            "turn_sound": {"game": "hearts", "sound": "chime"},
        },
    )
    assert response.status_code == 200
    assert response.json["user"]["profile_icon"] == "sparkles"
    assert response.json["user"]["turn_sound_options"]["hearts"]["sound"] == "chime"


def test_another_account_cannot_inherit_saved_sound_and_volume(client, app, user):
    from cards_accounts.models import User
    from cards_accounts.auth_utils import hash_password
    from tests.conftest import PASSWORD

    sign_in(client)
    post(
        client,
        "profile",
        {
            "turn_sound": {
                "game": "golf",
                "sound": "ding",
                "volume": 0.95,
                "enabled": True,
            }
        },
    )
    post(client, "logout")
    with app.app_context():
        db.session.add(
            User(
                username="second_player",
                email="second@example.test",
                password_hash=hash_password(PASSWORD),
                email_verified=True,
            )
        )
        db.session.commit()
    other = post(
        client, "login", {"username": "second_player", "password": PASSWORD}
    ).json["user"]
    assert other["turn_sound"]["golf"] is False
    assert other["turn_sound_options"]["golf"] == {"sound": "pop", "volume": 0.15}
