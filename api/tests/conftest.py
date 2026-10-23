from datetime import datetime
from pathlib import Path
import secrets

import pytest

from cards_accounts import create_app
from cards_accounts.extensions import db
from cards_accounts.schema import upgrade_schema
from cards_accounts.auth_utils import hash_password
from cards_accounts.models import User

ORIGIN = "http://localhost:3000"
PASSWORD = "account-test-password-123"
SECRET = "legacy-test-key-with-at-least-32-characters"
READ_TOKEN = secrets.token_urlsafe(40)
PROFILE_TOKEN = secrets.token_urlsafe(40)


@pytest.fixture
def app(tmp_path, monkeypatch):
    app = create_app(
        {
            "TESTING": True,
            "SQLALCHEMY_DATABASE_URI": "sqlite://",
            "CARDS_PUBLIC_URL": ORIGIN,
            "RATELIMIT_ENABLED": False,
            "JWT_SECRET": SECRET,
            "CARDS_EMAIL_TRANSPORT": "file",
            "CARDS_EMAIL_OUTBOX": str(tmp_path),
            "REQUIRE_GAME_PEERS": False,
            "INTERNAL_CLIENTS": {
                "games": {
                    "token": READ_TOKEN,
                    "scopes": ["sessions.validate", "profiles.read"],
                },
                "profiles-only": {"token": PROFILE_TOKEN, "scopes": ["profiles.read"]},
            },
        }
    )

    def game_call(game, operation, data):
        if operation == "preferences":
            return {
                "version": 1,
                "preferences": {
                    "card_style": "flourish",
                    "hard_level": "harder",
                    "mobile_layout": "single",
                },
            }
        return {"version": 1, "deleted": True, "request_id": data["request_id"]}

    monkeypatch.setattr("cards_accounts.game_client.call_game", game_call)
    monkeypatch.setattr("cards_accounts.deletions.call_game", game_call)
    with app.app_context():
        upgrade_schema()
    yield app
    with app.app_context():
        db.session.remove()
        db.engine.dispose()


@pytest.fixture
def user(app):
    with app.app_context():
        user = User(
            id=42,
            username="existing_player",
            email="existing@example.test",
            password_hash=hash_password(PASSWORD),
            email_verified=True,
            profile_icon="cat",
        )
        db.session.add(user)
        db.session.commit()
    return 42


@pytest.fixture
def client(app):
    return app.test_client()


def post(client, path, data=None, **headers):
    csrf = client.get("/account/session").json["csrf_token"]
    return client.post(
        "/account/" + path,
        json=data or {},
        headers={"Origin": ORIGIN, "X-CSRF-Token": csrf, **headers},
    )


def sign_in(client):
    return post(client, "login", {"username": "existing_player", "password": PASSWORD})


def private_headers(service="games", token=READ_TOKEN):
    return {"X-Cards-Service": service, "Authorization": "Bearer " + token}
