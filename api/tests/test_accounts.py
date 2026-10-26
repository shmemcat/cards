from datetime import datetime, timedelta
import json
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import pytest
import jwt

from cards_accounts.extensions import db
from cards_accounts.models import User, PasswordResetToken
from cards_accounts.account_sessions import AccountSession, fingerprint
from cards_accounts.email_utils import hash_token
from cards_accounts.deletions import DeletionRequest, process_deletion
from cards_accounts.game_client import GameUnavailable
from tests.conftest import (
    PASSWORD,
    SECRET,
    ORIGIN,
    post,
    sign_in,
    private_headers,
    PROFILE_TOKEN,
)


def mail_token(app):
    files = sorted(Path(app.config["CARDS_EMAIL_OUTBOX"]).glob("*.json"))
    return parse_qs(urlsplit(json.loads(files[-1].read_text())["url"]).query)["token"][
        0
    ]


def test_existing_account_cookie_and_profile_preserve_identity(client, user):
    session = sign_in(client)
    assert session.status_code == 200
    assert session.json["user"]["id"] == "42"
    assert session.json["user"]["preferences"]["card_style"] == "flourish"
    assert "HttpOnly" in session.headers["Set-Cookie"]
    assert "SameSite=Lax" in session.headers["Set-Cookie"]
    assert session.headers["Cache-Control"] == "no-store"
    assert (
        post(client, "profile", {"profile_icon": "sparkles"}).json["user"][
            "profile_icon"
        ]
        == "sparkles"
    )
    assert client.get("/me").json["user"]["id"] == 42


def test_cookie_mutations_require_csrf_and_allowed_origin(client, user):
    sign_in(client)
    assert (
        client.post("/account/profile", json={"profile_icon": "cat"}).status_code == 403
    )
    assert (
        post(
            client, "profile", {"profile_icon": "cat"}, Origin="https://foreign.test"
        ).status_code
        == 403
    )
    assert client.patch("/profile", json={"profile_icon": "cat"}).status_code == 403
    assert client.post("/account/login", data="x" * 16385).status_code in {403, 413}


def test_register_verify_and_replay(client, app):
    registered = post(
        client,
        "register",
        {"username": "new_player", "email": "new@example.test", "password": PASSWORD},
    )
    assert registered.status_code == 201
    token = mail_token(app)
    with app.app_context():
        assert User.query.one().verification_token == hash_token(token)
    assert post(client, "verify-email", {"token": token}).status_code == 200
    assert post(client, "verify-email", {"token": token}).status_code == 400
    assert (
        post(
            client, "login", {"username": "new@example.test", "password": PASSWORD}
        ).status_code
        == 200
    )


def test_reset_is_single_use_and_revokes_cookie_and_legacy_token(client, app, user):
    sign_in(client)
    legacy = jwt.encode({"sub": "42", "av": 0}, SECRET, algorithm="HS256")
    assert (
        post(client, "forgot-password", {"email": "existing@example.test"}).status_code
        == 200
    )
    token = mail_token(app)
    assert (
        post(
            client, "reset-password", {"token": token, "password": "new-password-123"}
        ).status_code
        == 200
    )
    assert (
        post(
            client, "reset-password", {"token": token, "password": PASSWORD}
        ).status_code
        == 400
    )
    assert client.get("/account/session").json["user"] is None
    assert (
        client.post(
            "/_internal/accounts/v1/legacy",
            json={"token": legacy},
            headers=private_headers(),
        ).json["user"]
        is None
    )


def test_email_change_revokes_sessions_and_old_recovery_links(client, app, user):
    sign_in(client)
    post(client, "forgot-password", {"email": "existing@example.test"})
    old = mail_token(app)
    changed = post(client, "profile", {"email": "changed@example.test"})
    assert changed.status_code == 200 and changed.json["user"] is None
    assert (
        post(client, "reset-password", {"token": old, "password": PASSWORD}).status_code
        == 400
    )
    assert sign_in(client).status_code == 403
    assert (
        post(
            client, "login", {"username": "changed@example.test", "password": PASSWORD}
        ).status_code
        == 403
    )


@pytest.mark.parametrize("kind", ["expired", "inactive", "password-changed"])
def test_session_revocation(client, app, user, kind):
    sign_in(client)
    with app.app_context():
        row = AccountSession.query.filter_by(user_id=user).one()
        if kind == "expired":
            row.expires_at = datetime.utcnow() - timedelta(seconds=1)
        elif kind == "inactive":
            row.last_seen_at = datetime.utcnow() - timedelta(hours=13)
        else:
            row.credential_hash = "invalidated"
        db.session.commit()
    assert client.get("/account/session").json["user"] is None


def test_private_api_is_scoped_and_returns_no_account_secrets(client, user):
    endpoint = "/_internal/accounts/v1/profiles"
    assert client.post(endpoint, json={"user_ids": [42]}).status_code == 401
    assert (
        client.post(
            endpoint,
            json={"user_ids": [42]},
            headers={"X-Cards-Service": "games", "Authorization": "Bearer forged"},
        ).status_code
        == 401
    )
    profile = client.post(
        endpoint, json={"user_ids": [42, 999]}, headers=private_headers()
    ).json
    assert profile == {
        "version": 1,
        "profiles": [
            {
                "id": 42,
                "username": "existing_player",
                "profile_icon": "cat",
                "email_verified": True,
            }
        ],
    }
    assert (
        client.post(
            "/_internal/accounts/v1/session",
            headers=private_headers("profiles-only", PROFILE_TOKEN),
        ).status_code
        == 403
    )
    assert (
        client.post(
            endpoint, json={"user_ids": [True]}, headers=private_headers()
        ).status_code
        == 400
    )
    assert (
        client.post(
            endpoint, json={"user_ids": list(range(501))}, headers=private_headers()
        ).status_code
        == 400
    )
    assert (
        client.post(
            "/_internal/accounts/v2/profiles", headers=private_headers()
        ).status_code
        == 404
    )


def test_private_session_preserves_guest_csrf_and_logout(client, user):
    guest = client.get("/account/session").json
    state = client.post(
        "/_internal/accounts/v1/session",
        headers={
            **private_headers(),
            "Origin": ORIGIN,
            "X-CSRF-Token": guest["csrf_token"],
        },
    ).json
    assert state["user"] is None and state["valid_csrf"] is True
    signed = sign_in(client).json
    state = client.post(
        "/_internal/accounts/v1/session",
        headers={
            **private_headers(),
            "Origin": ORIGIN,
            "X-CSRF-Token": signed["csrf_token"],
        },
    ).json
    assert state["user"]["id"] == 42
    assert post(client, "logout").json["user"] is None


def test_deletion_waits_for_both_games_and_revokes_immediately(
    client, app, user, monkeypatch
):
    sign_in(client)
    calls = []
    unavailable = {"euchre"}

    def cleanup(game, operation, data):
        calls.append(game)
        if game in unavailable:
            raise GameUnavailable("test outage")
        return {"version": 1, "deleted": True, "request_id": data["request_id"]}

    monkeypatch.setattr("cards_accounts.deletions.call_game", cleanup)
    result = post(client, "delete", {"password": PASSWORD})
    assert result.status_code == 202 and result.json["code"] == "DELETION_PENDING"
    assert result.json["user"] is None and result.json["csrf_token"]
    assert sign_in(client).status_code == 403
    with app.app_context():
        job = DeletionRequest.query.one()
        job_id = job.id
        assert db.session.get(User, 42) is not None
        assert AccountSession.query.filter_by(user_id=42).count() == 0
        assert json.loads(job.acknowledgements) == {"hearts": True}
        unavailable.clear()
        assert process_deletion(job_id)
        assert process_deletion(job_id)
        assert db.session.get(User, 42) is None
        assert calls == ["hearts", "euchre", "euchre"]
    # The SQLite account ID allocator must never reuse a deleted identity.
    assert (
        post(
            client,
            "register",
            {
                "username": "replacement",
                "email": "replacement@example.test",
                "password": PASSWORD,
            },
        ).status_code
        == 201
    )
    with app.app_context():
        assert User.query.one().id > 42


def test_wrong_password_cannot_create_a_cleanup_request(client, app, user):
    sign_in(client)
    assert post(client, "delete", {"password": "incorrect"}).status_code == 401
    with app.app_context():
        assert DeletionRequest.query.count() == 0


def test_health_and_readiness_are_component_specific(client):
    assert client.get("/health").json["component"] == "cards-accounts"
    assert client.get("/ready").status_code == 200


def test_accounts_service_has_no_game_registration_or_imports(app):
    assert set(app.blueprints) == {"auth", "cards_account", "private_accounts"}
    assert "socketio" not in app.extensions
    assert set(db.metadata.tables) == {
        "users",
        "password_reset_tokens",
        "account_sessions",
        "account_deletion_requests",
        "account_id_sequence",
        "account_turn_sound_options",
        "account_card_backs",
    }
    assert app.test_client().post("/games/start").status_code == 404


def test_preferences_outage_is_distinguishable_from_missing_preferences(
    client, user, monkeypatch
):
    def offline(*args):
        raise GameUnavailable("offline")

    monkeypatch.setattr("cards_accounts.game_client.call_game", offline)
    signed = sign_in(client)
    assert signed.status_code == 200
    assert signed.json["user"]["preferences"] is None
    assert signed.json["user"]["preferences_available"] is False


def test_pending_deletion_does_not_send_new_recovery_mail(
    client, user, app, monkeypatch
):
    def offline(*args):
        raise GameUnavailable("offline")

    monkeypatch.setattr("cards_accounts.deletions.call_game", offline)
    sign_in(client)
    assert post(client, "delete", {"password": PASSWORD}).status_code == 202
    before = list(Path(app.config["CARDS_EMAIL_OUTBOX"]).glob("*.json"))
    assert (
        post(client, "forgot-password", {"email": "existing@example.test"}).status_code
        == 200
    )
    assert (
        post(
            client, "resend-verification", {"email": "existing@example.test"}
        ).status_code
        == 200
    )
    assert list(Path(app.config["CARDS_EMAIL_OUTBOX"]).glob("*.json")) == before


def test_unexpected_foreign_key_keeps_deletion_pending(client, app, user):
    from sqlalchemy import text

    with app.app_context():
        db.session.execute(
            text(
                "CREATE TABLE unknown_dependency (user_id INTEGER REFERENCES users(id))"
            )
        )
        db.session.execute(text("INSERT INTO unknown_dependency VALUES (42)"))
        db.session.commit()
    sign_in(client)
    result = post(client, "delete", {"password": PASSWORD})
    assert result.status_code == 202 and result.json["user"] is None
    with app.app_context():
        job = DeletionRequest.query.one()
        assert json.loads(job.acknowledgements) == {"hearts": True, "euchre": True}
        assert db.session.get(User, 42) is not None
        db.session.execute(text("DELETE FROM unknown_dependency"))
        db.session.commit()
        assert process_deletion(job.id)
        assert db.session.get(User, 42) is None


def test_deletion_waits_for_configured_golf_without_changing_existing_games(client, app, user, monkeypatch):
    app.config["GAME_SERVICES"]["golf"] = {"url": "http://golf.invalid:5003", "token": "golf-callback-test-token-123456789012345"}
    sign_in(client)
    unavailable = {"golf"}
    calls = []
    def cleanup(game, operation, data):
        calls.append(game)
        if game in unavailable:
            raise GameUnavailable("test Golf outage")
        return {"version": 1, "deleted": True, "request_id": data["request_id"]}
    monkeypatch.setattr("cards_accounts.deletions.call_game", cleanup)
    assert post(client, "delete", {"password": PASSWORD}).status_code == 202
    with app.app_context():
        job = DeletionRequest.query.one()
        assert db.session.get(User, 42) is not None
        assert json.loads(job.acknowledgements) == {"hearts": True, "euchre": True}
        unavailable.clear()
        assert process_deletion(job.id)
        assert db.session.get(User, 42) is None
    assert calls == ["hearts", "euchre", "golf", "golf"]
