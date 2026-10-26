import pytest
from sqlalchemy import text

from cards_accounts.auth_utils import hash_password
from cards_accounts.card_backs import CARD_BACK_DESIGNS
from cards_accounts.extensions import db
from cards_accounts.models import CardBackOption, User
from cards_accounts.schema import schema_ready, upgrade_schema
from tests.conftest import PASSWORD, post, sign_in


def test_guest_cannot_save_and_existing_accounts_default_to_argyle(client, user):
    assert (
        post(
            client, "profile", {"card_back": {"game": "golf", "design": "ginkgo"}}
        ).status_code
        == 401
    )
    assert sign_in(client).json["user"]["card_backs"] == {"golf": "argyle"}


def test_all_approved_backs_persist_across_sessions_and_devices(client, app, user):
    sign_in(client)
    for design in CARD_BACK_DESIGNS["golf"]:
        response = post(
            client, "profile", {"card_back": {"game": "golf", "design": design}}
        )
        assert response.status_code == 200
        assert response.json["user"]["card_backs"]["golf"] == design
    second_device = app.test_client()
    assert sign_in(second_device).json["user"]["card_backs"]["golf"] == design
    post(second_device, "profile", {"card_back": {"game": "golf", "design": "ginkgo"}})
    assert client.get("/account/session").json["user"]["card_backs"]["golf"] == "ginkgo"
    post(client, "logout")
    assert client.get("/account/session").json["user"] is None
    assert sign_in(client).json["user"]["card_backs"]["golf"] == "ginkgo"
    with app.app_context():
        assert CardBackOption.query.filter_by(user_id=user).count() == 1


def test_another_account_never_inherits_the_choice(client, app, user):
    sign_in(client)
    post(client, "profile", {"card_back": {"game": "golf", "design": "fern-sprig"}})
    with app.app_context():
        db.session.add(
            User(
                username="another_player",
                email="another@example.test",
                password_hash=hash_password(PASSWORD),
                email_verified=True,
            )
        )
        db.session.commit()
    post(client, "logout")
    result = post(client, "login", {"username": "another_player", "password": PASSWORD})
    assert result.json["user"]["card_backs"] == {"golf": "argyle"}
    post(client, "profile", {"card_back": {"game": "golf", "design": "compass"}})
    post(client, "logout")
    assert sign_in(client).json["user"]["card_backs"]["golf"] == "fern-sprig"


@pytest.mark.parametrize(
    "value",
    [
        None,
        True,
        [],
        {},
        "ginkgo",
        {"game": "golf"},
        {"game": "other", "design": "ginkgo"},
        {"game": [], "design": "ginkgo"},
        {"game": "golf", "design": []},
        {"game": "golf", "design": "unknown"},
        {"game": "golf", "design": "../other.svg"},
        {"game": "golf", "design": "ginkgo", "user_id": 7},
    ],
)
def test_invalid_changes_are_rejected_atomically(client, user, value):
    sign_in(client)
    response = post(client, "profile", {"card_back": value, "profile_icon": "sparkles"})
    assert response.status_code == 400
    state = client.get("/account/session").json["user"]
    assert state["card_backs"] == {"golf": "argyle"}
    assert state["profile_icon"] == "cat"


def test_deletion_removes_saved_card_backs(client, app, user):
    sign_in(client)
    post(client, "profile", {"card_back": {"game": "golf", "design": "north-star"}})
    assert post(client, "delete", {"password": PASSWORD}).status_code == 200
    with app.app_context():
        assert CardBackOption.query.count() == 0


def test_additive_migration_preserves_accounts_sessions_and_turn_options(
    client, app, user
):
    sign_in(client)
    post(
        client,
        "profile",
        {
            "turn_sound": {
                "game": "golf",
                "enabled": True,
                "sound": "chime",
                "volume": 0.4,
            }
        },
    )
    with app.app_context():
        with db.engine.begin() as connection:
            connection.execute(text("DROP TABLE account_card_backs"))
            connection.execute(
                text(
                    "UPDATE cards_accounts_alembic_version SET version_num='accounts_003'"
                )
            )
        assert schema_ready()
    assert client.get("/account/session").json["user"]["card_backs"] == {
        "golf": "argyle"
    }
    assert post(client, "profile", {"profile_icon": "sparkles"}).status_code == 200
    assert (
        post(
            client, "profile", {"card_back": {"game": "golf", "design": "ginkgo"}}
        ).status_code
        == 503
    )
    with app.app_context():
        upgrade_schema()
        upgrade_schema()
        assert schema_ready()
    result = post(
        client, "profile", {"card_back": {"game": "golf", "design": "ginkgo"}}
    )
    state = result.json["user"]
    assert result.status_code == 200
    assert state["id"] == str(user)
    assert state["card_backs"]["golf"] == "ginkgo"
    assert state["profile_icon"] == "sparkles"
    assert state["turn_sound"]["golf"] is True
    assert state["turn_sound_options"]["golf"] == {"sound": "chime", "volume": 0.4}
