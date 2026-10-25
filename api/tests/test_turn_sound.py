import pytest

from cards_accounts.auth_utils import hash_password
from cards_accounts.extensions import db
from cards_accounts.models import TurnSoundOption, User
from tests.conftest import PASSWORD, post, sign_in


def test_existing_accounts_and_guests_default_to_off(client, user):
    assert client.get("/account/session").json["user"] is None
    assert (
        post(
            client, "profile", {"turn_sound": {"game": "golf", "enabled": True}}
        ).status_code
        == 401
    )
    assert sign_in(client).json["user"]["turn_sound"] == dict.fromkeys(
        ("golf", "euchre", "hearts"), False
    )


def test_new_accounts_default_to_off(client, app):
    assert (
        post(
            client,
            "register",
            {
                "username": "new_golfer",
                "email": "new@example.test",
                "password": PASSWORD,
            },
        ).status_code
        == 201
    )
    with app.app_context():
        assert User.query.one().to_dict()["turn_sound"] == dict.fromkeys(
            ("golf", "euchre", "hearts"), False
        )
        assert TurnSoundOption.query.count() == 0


@pytest.mark.parametrize("game", ["golf", "euchre", "hearts"])
def test_opt_in_is_saved_per_game_and_account(client, app, user, game):
    sign_in(client)
    result = post(client, "profile", {"turn_sound": {"game": game, "enabled": True}})
    assert result.status_code == 200
    expected = {name: name == game for name in ("golf", "euchre", "hearts")}
    assert result.json["user"]["turn_sound"] == expected
    post(client, "logout")
    assert client.get("/account/session").json["user"] is None
    with app.app_context():
        other = User(
            username="other_player",
            email="other@example.test",
            password_hash=hash_password(PASSWORD),
            email_verified=True,
        )
        db.session.add(other)
        db.session.commit()
    assert post(
        client, "login", {"username": "other_player", "password": PASSWORD}
    ).json["user"]["turn_sound"] == dict.fromkeys(expected, False)
    post(client, "logout")
    assert sign_in(client).json["user"]["turn_sound"] == expected
    result = post(client, "profile", {"turn_sound": {"game": game, "enabled": False}})
    assert result.json["user"]["turn_sound"] == dict.fromkeys(expected, False)


@pytest.mark.parametrize(
    "value",
    [
        None,
        True,
        [],
        {},
        {"game": "other", "enabled": True},
        {"game": "golf", "enabled": "true"},
        {"game": "golf", "enabled": 1},
    ],
)
def test_only_explicit_booleans_for_known_games_are_accepted(client, user, value):
    sign_in(client)
    assert post(client, "profile", {"turn_sound": value}).status_code == 400
    assert client.get("/account/session").json["user"]["turn_sound"]["golf"] is False


def test_deletion_removes_turn_sound_choices(client, app, user):
    sign_in(client)
    post(client, "profile", {"turn_sound": {"game": "hearts", "enabled": True}})
    assert post(client, "delete", {"password": PASSWORD}).status_code == 200
    with app.app_context():
        assert TurnSoundOption.query.count() == 0
