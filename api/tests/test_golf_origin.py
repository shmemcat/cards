import pytest

from cards_accounts.account_sessions import valid_origin


@pytest.mark.parametrize("origin", ["http://localhost:3003", "http://127.0.0.1:3003"])
def test_local_golf_origin_is_allowed(app, origin):
    with app.test_request_context(headers={"Origin": origin}):
        assert valid_origin()


def test_disposable_local_ports_require_explicit_configuration(app):
    origin = "http://localhost:54321"
    with app.test_request_context(headers={"Origin": origin}):
        assert not valid_origin()
        app.config["CORS_ORIGINS"] = [origin, "https://foreign.test"]
        assert valid_origin()
    with app.test_request_context(headers={"Origin": "https://foreign.test"}):
        assert not valid_origin()


def test_production_does_not_accept_development_origins(app):
    app.config["CARDS_PUBLIC_URL"] = "https://cards.example.test"
    app.config["CORS_ORIGINS"] = ["http://localhost:3003"]
    with app.test_request_context(headers={"Origin": "http://localhost:3003"}):
        assert not valid_origin()
    with app.test_request_context(headers={"Origin": "https://cards.example.test"}):
        assert valid_origin()
