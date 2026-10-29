from tests.conftest import sign_in


def test_local_preview_account_cookies_do_not_overwrite_other_previews(app, client, user):
    app.config["CARDS_COOKIE_NAME"] = "cards_session_55555"
    assert sign_in(client).json["user"]["id"] == str(user)
    signed = client.get_cookie("cards_session_55555").value
    app.config["CARDS_COOKIE_NAME"] = "cards_session_55556"
    assert client.get("/account/session").json["user"] is None
    assert client.get_cookie("cards_session_55555").value == signed
    # An unscoped cookie from an ordinary dev server is independent, too.
    client.set_cookie("cards_session", "unrelated-local-preview")
    app.config["CARDS_COOKIE_NAME"] = "cards_session_55555"
    assert client.get("/account/session").json["user"]["id"] == str(user)
