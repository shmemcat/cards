"""Development launcher for isolated split data; never reads project .env files."""

import sys

role, settings_path, operation = sys.argv[1:]
if role not in {"accounts", "hearts", "euchre", "golf"} or operation not in {
    "migrate",
    "serve",
}:
    raise SystemExit("Use accounts/hearts/euchre/golf and migrate/serve")
if role in {"hearts", "euchre"}:
    import eventlet

    eventlet.monkey_patch()

import json
import os
from pathlib import Path
import re

root = Path(__file__).resolve().parent.parent
settings_file = Path(settings_path).resolve()
local_root = (root / ".local").resolve()
directory = settings_file.parent
if (
    directory.parent != local_root
    or not directory.name.startswith("split-")
    or settings_file.name != "settings.json"
):
    raise RuntimeError(
        "Split data must be in a dedicated Cards/.local/split-* directory"
    )
settings = json.loads(settings_file.read_text(encoding="utf-8"))
if settings.get("version") != 1:
    raise RuntimeError("Unsupported local stack settings")
database = (directory / ("golf.sqlite" if role == "golf" else "state.sqlite")).resolve()
if database.parent != directory:
    raise RuntimeError("Refusing a database outside the isolated stack directory")
paths = {
    "accounts": root / "api",
    "hearts": root.parent / "hearts/game-api",
    "euchre": root.parent / "euchre/api",
    "golf": root.parent / "golf/api",
}
sys.path.insert(0, str(paths[role]))
origin = f"http://localhost:{settings['ports']['gateway']}"
games = ("hearts", "euchre", "golf") if os.environ.get("CARDS_DEV_GOLF") == "1" else ("hearts", "euchre")
config = {
    "SQLALCHEMY_DATABASE_URI": "sqlite:///" + database.as_posix(),
    "CARDS_PUBLIC_URL": origin,
    "FRONTEND_URL": origin,
    "CORS_ORIGINS": [
        origin,
        "http://localhost:3001",
        "http://localhost:3002",
        "http://localhost:3003",
        "http://127.0.0.1:3003",
        *json.loads(os.environ.get("CARDS_DEV_WEB_ORIGINS", "[]")),
    ],
    "COMPONENT_VERSION": "local-split",
    "SOURCE_REVISION": "working-tree",
}
if role == "accounts":
    from cards_accounts import create_app
    from cards_accounts.extensions import db
    from cards_accounts.schema import upgrade_schema

    app = create_app(
        {
            **config,
            "JWT_SECRET": settings["jwt"],
            "CARDS_EMAIL_TRANSPORT": "file",
            "CARDS_EMAIL_OUTBOX": str(directory / "outbox"),
            "SMTP2GO_API_KEY": "",
            "INTERNAL_CLIENTS": {
                game
                + "-game": {
                    "token": settings["read"][game],
                    "scopes": ["sessions.validate", "profiles.read"],
                }
                for game in games
            },
            "GAME_SERVICES": {
                game: {
                    "url": f"http://127.0.0.1:{settings['ports'][game]}",
                    "token": settings["callbacks"][game],
                }
                for game in games
            },
            "START_DELETION_WORKER": operation == "serve",
        }
    )
else:
    import importlib

    package = role + "_server"
    create_app = importlib.import_module(package).create_app
    db = importlib.import_module(package + ".extensions").db
    upgrade_schema = importlib.import_module(package + ".schema").upgrade_schema
    app = create_app(
        {
            **config,
            "CARDS_ACCOUNTS_URL": f"http://127.0.0.1:{settings['ports']['accounts']}",
            "CARDS_SERVICE_ID": role + "-game",
            "CARDS_SERVICE_TOKEN": settings["read"][role],
            "GAME_ACCOUNT_TOKENS": {role: settings["callbacks"][role]},
            **({"SECRET_KEY": settings["golfSecret"], "START_GOLF_WORKER": operation == "serve"} if role == "golf" else {}),
        }
    )

if operation == "migrate":
    with app.app_context():
        upgrade_schema()
else:
    if role != "accounts":
        from sqlalchemy import event

        forbidden = (
            "users|account_sessions|password_reset_tokens|account_deletion_requests|account_turn_sound_options"
        )
        forbidden += (
            "|euchre_tables|euchre_game_results"
            if role == "hearts"
            else "|active_games|user_stats|user_preferences|difficulty_stats|game_results"
        )
        with app.app_context():

            @event.listens_for(db.engine, "before_cursor_execute")
            def own_tables_only(
                connection, cursor, statement, parameters, context, executemany
            ):
                if re.search(
                    r'\b(?:FROM|JOIN|UPDATE|INTO)\s+["`]?\b(' + forbidden + r")\b",
                    statement,
                    re.I,
                ):
                    raise AssertionError(
                        "Game runtime attempted to access another service's records"
                    )

        provider = app.extensions["accounts"]
        original = provider._call

        def outside_gate(*args, **kwargs):
            if role != "golf":
                assert app.extensions["game_account_gate"].owner is None
            else:
                assert not app.extensions["golf_runtime"].lock._is_owned()
            return original(*args, **kwargs)

        provider._call = outside_gate
        app.extensions["socketio"].run(
            app,
            host="127.0.0.1",
            port=settings["ports"][role],
            use_reloader=False,
            log_output=False,
            **({"allow_unsafe_werkzeug": True} if role == "golf" else {}),
        )
    else:
        app.run(
            host="127.0.0.1",
            port=settings["ports"][role],
            threaded=True,
            use_reloader=False,
            load_dotenv=False,
        )
