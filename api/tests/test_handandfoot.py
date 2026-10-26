from tests.conftest import PASSWORD, post, sign_in
from cards_accounts.deletions import DeletionRequest, process_deletion
from cards_accounts.extensions import db
from cards_accounts.game_client import GameUnavailable
from cards_accounts.models import User


def test_handandfoot_origin_is_local_only(app):
    from flask import request
    from cards_accounts.account_sessions import valid_origin
    with app.test_request_context(headers={"Origin": "http://localhost:3004"}):
        assert valid_origin()
    app.config["CARDS_PUBLIC_URL"] = "https://cards.shmem.dev"
    with app.test_request_context(headers={"Origin": "http://localhost:3004"}):
        assert not valid_origin()


def test_configured_handandfoot_cleanup_is_required_before_final_deletion(client, app, user, monkeypatch):
    app.config["GAME_SERVICES"]["handandfoot"] = {"url": "http://127.0.0.1:5104", "token": "callback-" * 5}
    sign_in(client)
    calls = []
    blocked = {"handandfoot"}
    def cleanup(game, operation, data):
        calls.append(game)
        if game in blocked:
            raise GameUnavailable("test outage")
        return {"version": 1, "deleted": True, "request_id": data["request_id"]}
    monkeypatch.setattr("cards_accounts.deletions.call_game", cleanup)
    response = post(client, "delete", {"password": PASSWORD})
    assert response.status_code == 202
    with app.app_context():
        assert db.session.get(User, user) is not None
        blocked.clear()
        assert process_deletion(DeletionRequest.query.one().id)
        assert db.session.get(User, user) is None
    assert calls == ["hearts", "euchre", "handandfoot", "handandfoot"]
