import io

import pytest

from cards_accounts.game_client import call_game, GameUnavailable


@pytest.mark.parametrize(
    "payload",
    [b"invalid", b"[]", b'{"version":true}', b'{"version":2}', b"x" * 65537],
    ids=["json", "array", "boolean-version", "future-version", "oversized"],
)
def test_game_callback_rejects_invalid_contract(app, monkeypatch, payload):
    app.config["GAME_SERVICES"] = {
        "hearts": {"url": "http://private.invalid", "token": "x" * 40}
    }

    class Opener:
        def open(self, request, timeout):
            assert timeout == 2
            assert request.get_header("X-cards-service") == "accounts"
            return io.BytesIO(payload)

    def build(*handlers):
        assert handlers[0].proxies == {}
        assert (
            handlers[1].redirect_request(
                None, None, 302, None, None, "http://foreign.invalid"
            )
            is None
        )
        return Opener()

    monkeypatch.setattr("cards_accounts.game_client.urllib.request.build_opener", build)
    with app.app_context():
        with pytest.raises(GameUnavailable):
            call_game("hearts", "preferences", {"user_id": 42})


def test_callback_timeout_is_retryable(app, monkeypatch):
    app.config["GAME_SERVICES"] = {
        "hearts": {"url": "http://private.invalid", "token": "x" * 40}
    }

    class Opener:
        def open(self, request, timeout):
            raise TimeoutError()

    monkeypatch.setattr(
        "cards_accounts.game_client.urllib.request.build_opener", lambda *args: Opener()
    )
    with app.app_context(), pytest.raises(GameUnavailable):
        call_game("hearts", "delete-user", {"user_id": 42})
