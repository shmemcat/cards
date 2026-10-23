# Account source history

The accounts implementation originated in `shmemcat/hearts`, release `v5.0.2`,
commit `a28ebaf470a94aee611040af03bc0be4c6000aa6`.
The extraction follows the local application-factory/account-interface refactor.

Files carried into `cards_accounts/` retain their original filenames:
`account_routes.py`, `account_sessions.py`, `account_security.py`,
`account_http.py`, `account_access.py`, `account_contracts.py`, `auth_routes.py`,
`auth_utils.py`, `jwt_utils.py`, `email_utils.py`, and `email_templates.py`.
`extensions.py` retains the database and application-specific limiter facade.
`models.py` carries only the `User` and `PasswordResetToken` definitions; game
relationships were removed. Historical blame can be followed in the source
repository at those paths under `api/hearts/`.

The standalone application, private API, game callback client, deletion
coordinator, schema ownership, ID allocator, packaging, and tests are new here.
The original Hearts files remain available for the pinned combined deployment
until the reviewed cutover retires it.
