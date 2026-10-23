"""Private v1 API. Public proxies must never forward this prefix."""

from dataclasses import asdict
from functools import wraps
import secrets

from flask import Blueprint, current_app, jsonify, request
from cards_accounts.account_http import body
from cards_accounts.account_access import accounts

internal_bp = Blueprint(
    "private_accounts", __name__, url_prefix="/_internal/accounts/v1"
)


def require_service(scope):
    def decorate(view):
        @wraps(view)
        def checked(*args, **kwargs):
            principal = current_app.config["INTERNAL_CLIENTS"].get(
                request.headers.get("X-Cards-Service", "")
            )
            token = request.headers.get("Authorization", "")
            if (
                not principal
                or len(token) > 1024
                or not token.startswith("Bearer ")
                or not secrets.compare_digest(token[7:], principal["token"])
            ):
                return jsonify(error="Unauthorized"), 401
            if scope not in principal["scopes"]:
                return jsonify(error="Forbidden"), 403
            if request.content_length and request.content_length > 16384:
                return jsonify(error="Request too large"), 413
            return view(*args, **kwargs)

        return checked

    return decorate


@internal_bp.after_request
def no_store(response):
    response.headers["Cache-Control"] = "no-store"
    return response


@internal_bp.post("/session")
@require_service("sessions.validate")
def session():
    port = accounts()
    user, row = port.cookie_user(), port.session()
    return jsonify(
        version=1,
        user=asdict(user) if user else None,
        session=asdict(row) if row else None,
        valid_origin=port.valid_origin(),
        valid_csrf=port.valid_csrf(),
    )


@internal_bp.post("/legacy")
@require_service("sessions.validate")
def legacy():
    token = body().get("token")
    if not isinstance(token, str) or len(token) > 8192:
        return jsonify(error="Invalid credential"), 400
    user = accounts().legacy_user(token)
    return jsonify(version=1, user=asdict(user) if user else None)


@internal_bp.post("/profiles")
@require_service("profiles.read")
def profiles():
    ids = body().get("user_ids")
    if (
        not isinstance(ids, list)
        or len(ids) > 500
        or any(type(value) is not int or not 0 < value < 2**63 for value in ids)
    ):
        return jsonify(error="Submit up to 500 valid user IDs"), 400
    return jsonify(
        version=1,
        profiles=[asdict(value) for value in accounts().public_profiles(ids).values()],
    )
