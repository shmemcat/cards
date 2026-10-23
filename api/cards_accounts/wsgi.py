from cards_accounts import create_app

app = create_app({"START_DELETION_WORKER": True})
