"""Disposable combined backend for the routing checks; no live data or mail."""

import sys

sys.path.insert(0, sys.argv[1])

from flask import jsonify, request
from socketio.exceptions import ConnectionRefusedError
from hearts import create_app
from hearts.auth_utils import hash_password
from hearts.extensions import db
from hearts.models import User

app = create_app(
    {
        "TESTING": True,
        "SQLALCHEMY_DATABASE_URI": "sqlite://",
        "RATELIMIT_ENABLED": False,
        "CARDS_PUBLIC_URL": "http://localhost:3000",
        "CORS_ORIGINS": ["http://localhost:3000"],
        "CARDS_EMAIL_TRANSPORT": "file",
        "SMTP2GO_API_KEY": "",
    }
)
with app.app_context():
    db.create_all()
    db.session.add(
        User(
            username="routing_user",
            email="routing@example.test",
            password_hash=hash_password("routing-test-password"),
            email_verified=True,
            profile_icon="cat",
        )
    )
    db.session.commit()


@app.route("/_internal/private-probe", methods=["GET", "POST"])
@app.route("/account/_internal/private-probe", methods=["GET", "POST"])
@app.route("/account/euchre/_internal/private-probe", methods=["GET", "POST"])
def private_probe():
    # Deliberately unprotected in this disposable fixture: prove the proxy blocks it.
    return jsonify(private=True)


@app.route("/__routing_probe", methods=["GET", "POST"])
@app.route("/account/euchre/__routing_probe", methods=["GET", "POST"])
def probe():
    return jsonify(
        path=request.path,
        query=request.args.to_dict(),
        cookie=request.cookies.get("routing_probe"),
        origin=request.headers.get("Origin"),
        body=request.get_json(silent=True),
    )


@app.extensions["socketio"].on("connect", namespace="/__routing_reload")
def retired_transport(auth=None):
    raise ConnectionRefusedError(
        "This page has been updated. Please reload to reconnect.",
        {"code": "CLIENT_RELOAD_REQUIRED"},
    )


if __name__ == "__main__":
    print("Disposable routing backend ready", flush=True)
    app.extensions["socketio"].run(
        app,
        host="127.0.0.1",
        port=int(sys.argv[2]),
        use_reloader=False,
        log_output=False,
    )
