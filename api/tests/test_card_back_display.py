import pytest
from sqlalchemy import text

from cards_accounts.extensions import db
from cards_accounts.schema import schema_ready, upgrade_schema
from tests.conftest import post, sign_in, private_headers


def test_display_is_private_and_persists_independently_of_design_across_devices(
    client, app, user
):
    assert (
        post(
            client, "profile", {"card_back": {"game": "golf", "display": "players"}}
        ).status_code
        == 401
    )
    assert sign_in(client).json["user"]["card_back_display"] == {"golf": "uniform"}
    result = post(
        client, "profile", {"card_back": {"game": "golf", "display": "players"}}
    )
    assert result.status_code == 200
    assert result.json["user"]["card_backs"]["golf"] == "argyle"
    result = post(
        client, "profile", {"card_back": {"game": "golf", "design": "ginkgo"}}
    )
    assert result.json["user"]["card_back_display"]["golf"] == "players"
    second_device = app.test_client()
    signed = sign_in(second_device).json["user"]
    assert signed["card_backs"]["golf"] == "ginkgo"
    assert signed["card_back_display"]["golf"] == "players"
    profile = client.post(
        "/_internal/accounts/v1/profiles",
        json={"user_ids": [user]},
        headers=private_headers(),
    ).json["profiles"][0]
    assert profile["golf_card_back"] == "ginkgo"
    assert set(profile) == {
        "id",
        "username",
        "profile_icon",
        "email_verified",
        "golf_card_back",
    }
    result = post(
        second_device, "profile", {"card_back": {"game": "golf", "display": "uniform"}}
    )
    assert result.json["user"]["card_backs"]["golf"] == "ginkgo"
    assert (
        client.get("/account/session").json["user"]["card_back_display"]["golf"]
        == "uniform"
    )


@pytest.mark.parametrize("display", [None, True, 1, [], {}, "unknown"])
def test_invalid_display_never_changes_the_saved_design(client, user, display):
    sign_in(client)
    result = post(
        client,
        "profile",
        {"card_back": {"game": "golf", "design": "ginkgo", "display": display}},
    )
    assert result.status_code == 400
    saved = client.get("/account/session").json["user"]
    assert saved["card_backs"]["golf"] == "argyle"
    assert saved["card_back_display"]["golf"] == "uniform"


def test_compatible_server_preserves_designs_and_existing_sessions_before_display_migration(
    client, app, user
):
    sign_in(client)
    post(client, "profile", {"card_back": {"game": "golf", "design": "ginkgo"}})
    with app.app_context():
        with db.engine.begin() as connection:
            connection.execute(
                text("ALTER TABLE account_card_backs DROP COLUMN display_mode")
            )
            connection.execute(
                text(
                    "UPDATE cards_accounts_alembic_version SET version_num='accounts_004'"
                )
            )
        assert schema_ready()
    saved = client.get("/account/session").json["user"]
    assert saved["card_backs"]["golf"] == "ginkgo"
    assert saved["card_back_display"]["golf"] == "uniform"
    assert (
        post(
            client, "profile", {"card_back": {"game": "golf", "design": "north-star"}}
        ).status_code
        == 200
    )
    assert (
        post(
            client, "profile", {"card_back": {"game": "golf", "display": "players"}}
        ).status_code
        == 503
    )
    with app.app_context():
        upgrade_schema()
        upgrade_schema()
        assert schema_ready()
    result = post(
        client, "profile", {"card_back": {"game": "golf", "display": "players"}}
    )
    assert result.status_code == 200
    assert result.json["user"]["card_backs"]["golf"] == "north-star"
    assert result.json["user"]["card_back_display"]["golf"] == "players"
