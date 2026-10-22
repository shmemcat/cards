"""Local account API using a fresh Cards database, never the live Hearts database."""

import os
from pathlib import Path
import secrets
import sys

root = Path(__file__).resolve().parent.parent
api = Path(
    os.environ.get("HEARTS_API_PATH", str(root.parent / "hearts" / "api"))
).resolve()
sys.path.insert(0, str(api))
local = root / ".local"
local.mkdir(exist_ok=True)
database = local / "accounts.sqlite"
# Only mail-provider configuration is reused. No existing database credentials are loaded.
env_file = api.parent / ".env"
if env_file.exists():
    for line in env_file.read_text(encoding="utf-8-sig").splitlines():
        name, separator, value = line.partition("=")
        if separator and name.strip() in {"SMTP2GO_API_KEY", "SMTP2GO_FROM_EMAIL"}:
            os.environ.setdefault(name.strip(), value.strip().strip('"').strip("'"))
os.environ["DATABASE_URL"] = "sqlite:///" + database.as_posix()
os.environ["CARDS_PUBLIC_URL"] = "http://localhost:3000"
os.environ["FRONTEND_URL"] = "http://localhost:3000"
os.environ["CORS_ORIGINS"] = ",".join(
    f"http://{host}:{port}"
    for host in ("localhost", "127.0.0.1")
    for port in (3000, 3001, 3002)
)
os.environ.setdefault("JWT_SECRET", secrets.token_urlsafe(48))
os.environ.setdefault("CARDS_EMAIL_TRANSPORT", "file")
os.environ["CARDS_EMAIL_OUTBOX"] = str(local / "outbox")

from hearts import app, socketio
from hearts.extensions import db
from sqlalchemy import inspect, text

with app.app_context():
    inspector = inspect(db.engine)
    if inspector.has_table("users") and "auth_version" not in {
        column["name"] for column in inspector.get_columns("users")
    }:
        raise RuntimeError(
            "The local database needs migration 017; it has not been modified."
        )
    db.create_all()
    # This runner owns only Cards/.local/accounts.sqlite, which predates Alembic.
    # Preserve its users/results while adding the multiplayer counters from 019.
    columns = {
        column["name"]
        for column in inspect(db.engine).get_columns("euchre_game_results")
    }
    for name in ("marches", "loners", "euchres"):
        if name not in columns:
            db.session.execute(
                text(
                    f"ALTER TABLE euchre_game_results ADD COLUMN {name} INTEGER NOT NULL DEFAULT 0"
                )
            )
    db.session.commit()

print("Shared Cards accounts: http://127.0.0.1:5000", flush=True)
print("Local database: Cards/.local/accounts.sqlite", flush=True)
print("Email delivery: " + app.config["CARDS_EMAIL_TRANSPORT"], flush=True)
if __name__ == "__main__":
    socketio.run(app, host="127.0.0.1", port=5000, use_reloader=True)
