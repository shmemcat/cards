import pytest

from cards_accounts.card_backs import CARD_BACK_DESIGNS
from tests.conftest import post, sign_in, private_headers


def test_handandfoot_defaults_and_display_first_save_preserve_golf(client, app, user):
    signed = sign_in(client).json["user"]
    assert signed["card_backs"]["handandfoot"] == "single-leaves"
    assert signed["card_back_display"]["handandfoot"] == "uniform"
    post(client, "profile", {"card_back": {"game": "golf", "design": "ginkgo"}})
    result = post(client, "profile", {"card_back": {"game": "handandfoot", "display": "players"}})
    assert result.status_code == 200
    assert result.json["user"]["card_backs"] == {"golf": "ginkgo", "handandfoot": "single-leaves"}
    assert result.json["user"]["card_back_display"] == {"golf": "uniform", "handandfoot": "players"}
    assert len(CARD_BACK_DESIGNS["handandfoot"]) == 35
    for design in CARD_BACK_DESIGNS["handandfoot"]:
        result = post(client, "profile", {"card_back": {"game": "handandfoot", "design": design}})
        assert result.status_code == 200
        assert result.json["user"]["card_backs"]["handandfoot"] == design
        assert result.json["user"]["card_backs"]["golf"] == "ginkgo"
        assert result.json["user"]["card_back_display"]["handandfoot"] == "players"
    second_device = app.test_client()
    assert sign_in(second_device).json["user"]["card_backs"]["handandfoot"] == design
    profile = client.post("/_internal/accounts/v1/profiles", json={"user_ids": [user]}, headers=private_headers()).json["profiles"][0]
    assert profile["handandfoot_card_back"] == design
    assert "card_back_display" not in profile


@pytest.mark.parametrize("design", ["four-leaf", "fern", "garden-trellis", "unknown", "../other.svg", None])
def test_unapproved_handandfoot_backs_are_rejected_atomically(client, user, design):
    sign_in(client)
    result = post(client, "profile", {"card_back": {"game": "handandfoot", "design": design, "display": "players"}})
    assert result.status_code == 400
    saved = client.get("/account/session").json["user"]
    assert saved["card_backs"]["handandfoot"] == "single-leaves"
    assert saved["card_back_display"]["handandfoot"] == "uniform"
