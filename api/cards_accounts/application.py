"""Independent account application; no game imports or socket server."""

import json
import os
from urllib.parse import urlsplit

from flask import Flask, jsonify, request
from flask_cors import CORS
from sqlalchemy.engine import make_url
from werkzeug.middleware.proxy_fix import ProxyFix

from cards_accounts.extensions import db, limiter


def create_app(config=None):
    app = Flask("cards_accounts")
    app.config.from_mapping(
        SQLALCHEMY_DATABASE_URI=os.environ.get("DATABASE_URL", "sqlite:///accounts.db"),
        SQLALCHEMY_TRACK_MODIFICATIONS=False,
        JWT_SECRET=os.environ.get("JWT_SECRET", ""),
        CARDS_PUBLIC_URL=os.environ.get("CARDS_PUBLIC_URL", ""),
        CORS_ORIGINS=os.environ.get(
            "CORS_ORIGINS",
            "http://localhost:3000,http://localhost:3001,http://localhost:3002",
        ),
        TRUSTED_PROXY_HOPS=int(os.environ.get("TRUSTED_PROXY_HOPS", "0")),
        FRONTEND_URL=os.environ.get("FRONTEND_URL", "http://localhost:3000"),
        CARDS_EMAIL_TRANSPORT=os.environ.get("CARDS_EMAIL_TRANSPORT", "smtp2go"),
        CARDS_EMAIL_OUTBOX=os.environ.get(
            "CARDS_EMAIL_OUTBOX", os.path.join(app.instance_path, "cards-outbox")
        ),
        SMTP2GO_API_KEY=os.environ.get("SMTP2GO_API_KEY", ""),
        SMTP2GO_FROM_EMAIL=os.environ.get("SMTP2GO_FROM_EMAIL", "noreply@shmem.dev"),
        INTERNAL_CLIENTS=json.loads(os.environ.get("CARDS_INTERNAL_CLIENTS", "{}")),
        GAME_SERVICES=json.loads(os.environ.get("CARDS_GAME_SERVICES", "{}")),
        START_DELETION_WORKER=False,
        REQUIRE_GAME_PEERS=True,
        COMPONENT_VERSION=os.environ.get("CARDS_ACCOUNTS_VERSION", "development"),
        SOURCE_REVISION=os.environ.get("CARDS_SOURCE_REVISION", "unknown"),
    )
    app.config.update(config or {})
    uri = make_url(app.config["SQLALCHEMY_DATABASE_URI"])
    if uri.drivername == "postgresql":
        uri = uri.set(drivername="postgresql+psycopg2")
    app.config["SQLALCHEMY_DATABASE_URI"] = uri
    public = urlsplit(app.config["CARDS_PUBLIC_URL"].rstrip("/"))
    if public.geturl() and (
        not public.hostname
        or public.path
        or public.query
        or public.fragment
        or public.username
        or public.password
        or (
            public.scheme != "https"
            and not (
                public.scheme == "http"
                and public.hostname in {"localhost", "127.0.0.1"}
            )
        )
    ):
        raise ValueError(
            "CARDS_PUBLIC_URL must be an HTTPS origin (HTTP allowed on localhost)."
        )
    app.config["CARDS_PUBLIC_URL"] = public.geturl()
    app.config["CARDS_ACCOUNT_ENABLED"] = bool(public.geturl())
    app.config["CARDS_COOKIE_SECURE"] = public.scheme == "https"
    hops = app.config["TRUSTED_PROXY_HOPS"]
    if not 0 <= hops <= 3:
        raise ValueError("TRUSTED_PROXY_HOPS must be between 0 and 3")
    if hops:
        app.wsgi_app = ProxyFix(app.wsgi_app, x_for=hops)
    for principal in app.config["INTERNAL_CLIENTS"].values():
        if (
            not isinstance(principal.get("token"), str)
            or len(principal["token"]) < 32
            or not isinstance(principal.get("scopes"), list)
        ):
            raise ValueError(
                "Internal clients require a strong token and explicit scopes"
            )
    from cards_accounts.game_client import validate_peer

    for peer in app.config["GAME_SERVICES"].values():
        validate_peer(peer)
    db.init_app(app)
    with app.app_context():
        if db.engine.dialect.name == "sqlite":
            from sqlalchemy import event

            @event.listens_for(db.engine, "connect")
            def foreign_keys(connection, record):
                connection.execute("PRAGMA foreign_keys=ON")

    CORS(
        app,
        origins=(
            [
                value.strip()
                for value in app.config["CORS_ORIGINS"].split(",")
                if value.strip()
            ]
            if isinstance(app.config["CORS_ORIGINS"], str)
            else app.config["CORS_ORIGINS"]
        ),
    )
    from cards_accounts.local import LocalAccounts
    from cards_accounts.account_routes import account_bp
    from cards_accounts.auth_routes import auth_bp
    from cards_accounts.internal import internal_bp
    from cards_accounts.account_http import protect_cookie_requests
    from cards_accounts.deletions import start_worker

    app.extensions["accounts"] = LocalAccounts()
    for blueprint in (account_bp, auth_bp, internal_bp):
        app.register_blueprint(blueprint)
    limiter.init_app(app)

    @app.before_request
    def cookie_guard():
        if not request.path.startswith("/_internal/"):
            return protect_cookie_requests()

    @app.get("/health")
    def health():
        return jsonify(
            status="ok",
            component="cards-accounts",
            version=app.config["COMPONENT_VERSION"],
            revision=app.config["SOURCE_REVISION"],
        )

    @app.get("/ready")
    def ready():
        from cards_accounts.schema import schema_ready

        configured = (
            bool(app.config["CARDS_PUBLIC_URL"])
            and bool(app.config["INTERNAL_CLIENTS"])
            and (
                not app.config["REQUIRE_GAME_PEERS"]
                or {"hearts", "euchre"} <= app.config["GAME_SERVICES"].keys()
            )
        )
        good = configured and schema_ready()
        return jsonify(
            status="ready" if good else "not-ready", component="cards-accounts"
        ), (200 if good else 503)

    if app.config["START_DELETION_WORKER"]:
        start_worker(app)
    return app
