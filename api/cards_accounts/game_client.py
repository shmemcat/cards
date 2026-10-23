"""Bounded calls to each game's private account-data interface."""

import json
import urllib.error
import urllib.request
from urllib.parse import urlsplit

from flask import current_app, g, has_request_context


class GameUnavailable(RuntimeError):
    pass


def validate_peer(peer):
    parsed = urlsplit(peer.get("url", ""))
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
        or parsed.path not in {"", "/"}
    ):
        raise ValueError("Game service URLs must be HTTP(S) origins.")
    if not isinstance(peer.get("token"), str) or len(peer["token"]) < 32:
        raise ValueError("Game service tokens must contain at least 32 characters.")


def call_game(game, operation, data):
    peer = current_app.config["GAME_SERVICES"].get(game)
    if not peer:
        raise GameUnavailable("Game service is not configured")
    validate_peer(peer)
    request = urllib.request.Request(
        f'{peer["url"].rstrip("/")}/_internal/games/v1/{game}/{operation}',
        data=json.dumps(data).encode(),
        method="POST",
        headers={
            "Content-Type": "application/json",
            "X-Cards-Service": "accounts",
            "Authorization": "Bearer " + peer["token"],
        },
    )

    # Redirects must not carry a private credential to another origin.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None

    try:
        with urllib.request.build_opener(
            urllib.request.ProxyHandler({}), NoRedirect
        ).open(request, timeout=2) as response:
            raw = response.read(65537)
            if len(raw) > 65536:
                raise ValueError("Oversized game response")
            result = json.loads(raw)
            if not isinstance(result, dict) or (
                type(result.get("version")) is not int or result["version"] != 1
            ):
                raise ValueError("Unsupported game contract")
            return result
    except (OSError, ValueError, urllib.error.URLError) as error:
        raise GameUnavailable("Game service is temporarily unavailable") from error


def profile_preferences(user_id):
    if not has_request_context():
        return None
    cache = g.setdefault("cards.preferences", {})
    if user_id not in cache:
        try:
            result = call_game("hearts", "preferences", {"user_id": user_id})
            if "preferences" not in result:
                raise GameUnavailable("Incomplete preference response")
            preferences = result["preferences"]
            if preferences is not None and (
                not isinstance(preferences, dict)
                or any(
                    not isinstance(preferences.get(key), str)
                    for key in ("card_style", "hard_level", "mobile_layout")
                )
            ):
                raise GameUnavailable("Invalid preferences")
            cache[user_id] = (preferences, True)
        except GameUnavailable:
            cache[user_id] = (None, False)
    return cache[user_id][0]


def preferences_available(user_id):
    profile_preferences(user_id)
    return g.get("cards.preferences", {}).get(user_id, (None, False))[1]
