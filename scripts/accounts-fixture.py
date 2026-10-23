"""Disposable two-process accounts/game rehearsal. Never imports live config."""

import sys
from pathlib import Path

role, database, port, accounts_port, games_port, secret = sys.argv[1:7]
euchre_port = sys.argv[7] if len(sys.argv) > 7 else games_port
root = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(root / "api"))
origin = "http://localhost:3000"
read_key, hearts_key, euchre_key = (
    secret + suffix for suffix in ("-read", "-hearts", "-euchre")
)
config = {
    "TESTING": True,
    "SQLALCHEMY_DATABASE_URI": "sqlite:///" + database,
    "CARDS_PUBLIC_URL": origin,
    "CORS_ORIGINS": [origin],
    "RATELIMIT_ENABLED": False,
}

if role == "accounts":
    from datetime import datetime, timedelta
    from flask import request
    from cards_accounts import create_app
    from cards_accounts.extensions import db
    from cards_accounts.schema import upgrade_schema
    from cards_accounts.models import User
    from cards_accounts.account_sessions import AccountSession
    from cards_accounts.auth_utils import hash_password
    from cards_accounts.deletions import DeletionRequest, process_deletion

    app = create_app(
        {
            **config,
            "JWT_SECRET": secret,
            "CARDS_EMAIL_TRANSPORT": "file",
            "CARDS_EMAIL_OUTBOX": str(Path(database).parent / "outbox"),
            "INTERNAL_CLIENTS": {
                "hearts-game": {
                    "token": secret + "-read-hearts",
                    "scopes": ["sessions.validate", "profiles.read"],
                },
                "euchre-game": {
                    "token": secret + "-read-euchre",
                    "scopes": ["sessions.validate", "profiles.read"],
                },
                "combined-games": {
                    "token": read_key,
                    "scopes": ["sessions.validate", "profiles.read"],
                },
            },
            "GAME_SERVICES": {
                game: {
                    "url": "http://127.0.0.1:"
                    + (euchre_port if game == "euchre" else games_port),
                    "token": key,
                }
                for game, key in (("hearts", hearts_key), ("euchre", euchre_key))
            },
        }
    )
    with app.app_context():
        upgrade_schema()
        if not User.query.first() and not DeletionRequest.query.first():
            db.session.add(
                User(
                    id=42,
                    username="rehearsal",
                    email="rehearsal@example.test",
                    password_hash=hash_password("rehearsal-password-123"),
                    email_verified=True,
                    profile_icon="cat",
                )
            )
            db.session.commit()

    @app.post("/_internal/test/control")
    def control():
        assert request.headers.get("X-Test-Key") == secret
        data = request.get_json()
        if data["action"] == "expire":
            for row in AccountSession.query.filter_by(user_id=42):
                row.expires_at = datetime.utcnow() - timedelta(seconds=1)
            db.session.commit()
        elif data["action"] == "euchre-offline":
            app.config["GAME_SERVICES"]["euchre"]["url"] = "http://127.0.0.1:1"
        elif data["action"] == "retry":
            app.config["GAME_SERVICES"]["euchre"][
                "url"
            ] = f"http://127.0.0.1:{euchre_port}"
            for row in DeletionRequest.query.filter_by(status="pending").all():
                process_deletion(row.id)
        return {
            "user_exists": db.session.get(User, 42) is not None,
            "jobs": [{"status": row.status} for row in DeletionRequest.query],
        }

    app.run(host="127.0.0.1", port=int(port), threaded=True, use_reloader=False)
else:
    # Match the existing production eventlet worker before importing networking.
    import eventlet

    eventlet.monkey_patch()
    import json
    import re
    from flask import request
    from sqlalchemy import event

    sys.path.insert(0, str(root.parent / "hearts" / "api"))
    from hearts import create_app
    from hearts.extensions import db
    from hearts.models import (
        UserPreferences,
        UserStats,
        EuchreGameResult,
        ActiveGame,
        EuchreTable,
    )
    from hearts.game_accounts import upgrade_schema, receipts

    app = create_app(
        {
            **config,
            "CARDS_ACCOUNTS_URL": f"http://127.0.0.1:{accounts_port}",
            "CARDS_SERVICE_ID": "hearts-game" if role == "hearts" else "combined-games",
            "CARDS_SERVICE_TOKEN": (
                secret + "-read-hearts" if role == "hearts" else read_key
            ),
            "GAME_ACCOUNT_TOKENS": {"hearts": hearts_key, "euchre": euchre_key},
        },
        role="hearts" if role == "hearts" else "combined",
    )
    with app.app_context():
        db.create_all()  # Disposable bootstrap only; never used by the runtime.
        upgrade_schema()
        db.session.add(UserPreferences(user_id=42, card_style="flourish"))
        db.session.add(UserStats(user_id=42, games_played=1, games_won=1))
        db.session.commit()

        @event.listens_for(db.engine, "before_cursor_execute")
        def no_account_reads(
            connection, cursor, statement, parameters, context, executemany
        ):
            if re.search(
                r"\b(?:FROM|JOIN|UPDATE|INTO|DELETE FROM)\s+[\"`]?\b(users|account_sessions|password_reset_tokens)\b",
                statement,
                re.I,
            ):
                raise AssertionError("Game runtime accessed an account-owned table")

    # Every real identity/profile call must happen outside the game write gate.
    provider = app.extensions["accounts"]
    call = provider._call

    def unlocked_call(*args, **kwargs):
        assert (
            app.extensions["game_account_gate"].owner is None
        ), "Account RPC inside game gate"
        return call(*args, **kwargs)

    provider._call = unlocked_call

    @app.get("/_internal/test/state")
    def state():
        assert request.headers.get("X-Test-Key") == secret
        from hearts import euchre_multiplayer as mp, lobby

        if role == "hearts":
            return {
                "solo": ActiveGame.query.filter_by(user_id=42).count(),
                "preferences": UserPreferences.query.filter_by(user_id=42).count(),
                "stats": UserStats.query.filter_by(user_id=42).count(),
                "lobbies": [value.to_dict() for value in lobby._lobbies.values()],
            }
        return {
            "solo": ActiveGame.query.filter_by(user_id=42).count(),
            "preferences": UserPreferences.query.filter_by(user_id=42).count(),
            "stats": UserStats.query.filter_by(user_id=42).count(),
            "results": EuchreGameResult.query.filter_by(user_id=42).count(),
            "tables": [json.loads(row.snapshot) for row in EuchreTable.query],
            "cached": list(mp._tables.values()),
            "lobbies": [value.to_dict() for value in lobby._lobbies.values()],
        }

    app.extensions["socketio"].run(
        app, host="127.0.0.1", port=int(port), use_reloader=False, log_output=False
    )
