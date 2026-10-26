# Account interface v1 and separable application entrypoints

This document records the first slice and its frozen compatibility baseline. The subsequent remote transport, standalone account schema, distributed deletion, and runtime privilege policy are implemented in phase 3; see [accounts service](accounts-service.md). Descriptions of pending work below refer to the original first-slice boundary.

Implemented locally on 2026-10-22 as the first slice of the [server separation plan](game-server-separation-plan.md). This slice changes application composition and introduces an in-process account boundary. The combined deployment remains the default.

The subsequent [routing compatibility slice](game-routing-compatibility.md) adds public game URL aliases and updates clients, while retaining this same backend and account interface. The unchanged-routing statements below describe the first slice itself.

## Application composition

`hearts/api/hearts/application.py` exposes `create_app(config=None, *, role="combined", accounts=None)`.

- `combined` registers accounts, legacy authentication, both games, and all four socket namespaces.
- `accounts` registers shared accounts and legacy authentication. It creates no Socket.IO server.
- `hearts` registers Hearts games, statistics, preferences, lobbies, and leaderboards, with `/game`, `/lobby`, and `/multi` sockets.
- `euchre` registers Euchre results and leaderboards, with `/euchre` sockets. Its existing `/account/euchre/` URLs remain game-owned compatibility routes.
- Every role retains `/health` and Flask's static route. Game roles do not register account creation, login, recovery, profile mutation, or deletion routes.

These roles are composition and testing boundaries. They are not independently deployable services yet: models, database access, migrations, and several profile joins still share the existing implementation.

`hearts:app` lazily creates one combined application. `from hearts import app, socketio, migrate` retains its existing behavior. Importing the engine or creating an explicit factory app does not initialize that default application. There is deliberately no environment variable that changes the deployed service role.

Each app owns its Socket.IO server, game caches, lobby stores, SID maps, timers, Euchre lock, and rate-limit counters. Background callbacks retain their originating app. Direct runtime helpers require that app's context; the standalone lobby library keeps a separate context-free store for pure engine use. Context-free legacy reset helpers still target the default app.

No changes are made to Docker commands, worker count, transport paths, gateway routing, deployment workflows, credentials, or migration execution. The deployed command remains `gunicorn -c gunicorn_conf.py hearts:app`; startup still runs the existing migration chain.

## Account port

The Python contract is `hearts.account_contracts.Accounts`, version `ACCOUNT_CONTRACT_VERSION = 1`. Supply an adapter with `create_app(..., accounts=adapter)`. The default `LocalAccounts` uses the same database and session implementation as the existing combined server and makes no network calls.

Game authentication, HTTP cookie guards, Euchre handshake and command validation, player icon lookup, and password-confirmed account deletion call this port. Account routes continue to own account creation and mutation through their local implementation.

The contract uses immutable records:

- `AccountIdentity`: integer `id`, `username`, `profile_icon`, and `email_verified`, with additive `golf_card_back` defaulting to `argyle`. Existing integer IDs are preserved. The selected Golf design is public appearance metadata; the viewer's display preference stays private. This record contains no email address, password hash, verification/recovery token, or ORM object.
- `AccountSession`: `csrf_token`, available only inside the server boundary. This is distinct from the database session model and is never a raw session cookie.
- `DeletionResult`: `deleted`, `message`, and HTTP-compatible `status_code` for the existing account route response.

Operations and semantics:

- `session()` returns the current valid session metadata, including an anonymous CSRF session, or `None`. It retains current expiry, inactivity, password-change, verification, and logout checks.
- `cookie_user()` returns the signed-in account or `None` for an absent, invalid, expired, revoked, or anonymous session. Cookie identity still requires email verification.
- `legacy_user(token)` validates the supported HS256 JWT and its `auth_version`. It returns an identity or `None`, preserving legacy verification behavior. Cookie identity takes precedence over bearer authentication. Hearts multiplayer also retains its legacy `auth_token` query fallback.
- `public_profiles(user_ids)` returns a dictionary keyed by existing integer IDs; unknown IDs are omitted. It is a batched public-profile lookup, not proof that a user is currently authenticated. Unverified users retain the same profile visibility as before.
- `valid_origin()` and `valid_csrf()` use the current request and preserve the existing origin, session, and token rules.
- `refresh()` discards request-local credential validation before another authoritative check. Euchre calls it before each signed-in socket command so a persistent handshake cannot bypass logout or password recovery. This slice preserves Hearts' existing seat-token and connection-time identity model; extending its per-command validation belongs to extraction.
- `delete_account(user_id, password)` performs the existing local password-confirmed transaction. Missing passwords return 400; incorrect passwords return 401; completed deletion returns 200. Both legacy and shared account deletion reach this adapter.

## Absence, errors, and compatibility

`None` means credential validation completed without a signed-in identity. It must never stand for an unavailable account provider. Adapters raise `AccountsUnavailable` when validation cannot complete.

HTTP callers receive 503 with `code: "ACCOUNTS_UNAVAILABLE"` and a generic retry message. Socket handshakes are rejected; an affected Euchre command receives `ok: false` with the same code. Diagnostic details are not returned. A failed Hearts reconnect preserves the previous connection bookkeeping. Invalid credentials retain the current 401 or guest behavior appropriate to each endpoint, and CSRF errors retain `CSRF_INVALID`/403.

There is no remote transport, timeout policy, authentication cache, or private HTTP endpoint in this slice. Before introducing a remote adapter, move account I/O outside game locks, specify bounded timeouts, and prevent an outage from causing a disconnect penalty or partial result write. The local adapter cannot yet provide distributed failure recovery.

Version 1 is the first internal port; there is no previous distributed contract to support. Existing public browser APIs remain compatible independently of this port version. Preserve v1 field and operation semantics when extracting it. Any future wire protocol needs explicit version negotiation, unknown-field tolerance, rejection of unsupported versions, and tests for the current and previous supported versions before separate releases are enabled.

## Deletion boundary and remaining ownership work

Local deletion still removes the same rows in one transaction: password reset tokens, active Hearts games, Hearts totals/preferences/difficulty statistics/results, Euchre results, account sessions, then the user.

This is not the final cross-service deletion protocol. It does not add durable cleanup requests, acknowledgements, idempotency keys, or cleanup of account data embedded in Euchre JSON snapshots and live runners. Those require a later contract and migration before independent account/game services can be released. Do not reinterpret a successful local `DeletionResult` as evidence that distributed cleanup has been implemented.

The current account-related ORM joins in `leaderboard_routes.py` and `euchre_routes.py` remain to be replaced during extraction. Euchre result submission still locks a local `User` row to coordinate with deletion. Shared foreign keys and result writes also still assume the current database layout.

## Public surface inventory

The machine-readable inventory is `hearts/api/tests/fixtures/combined_surface_v1.json`, recorded from deployed tag `v5.0.2` (`a28ebaf`), and checked against the new combined factory. It contains every route/method/endpoint, incoming socket event, and registered table: 43 routes, 19 socket event registrations, and 10 tables. Counts include `/health` and Flask's static route, and omit automatic HEAD/OPTIONS methods.

Route groups, relative to the existing proxy's `/api/` prefix:

- Accounts: `GET /account/session`; POST `/account/{login,logout,register,verify-email,resend-verification,forgot-password,reset-password,profile,delete}`.
- Legacy accounts: POST `/{register,login,verify-email,forgot-password,reset-password,resend-verification}`; `PATCH /profile`; `GET /me`; `DELETE /account`.
- Hearts games: `POST /games/start`; `GET /games/active`; `GET /games/<game_id>`; POST `/games/<game_id>/{pass,advance,play,concede}`.
- Hearts lobby API: `POST /lobbies/create`; `GET /lobbies/<code>`; `GET /lobbies/game/<game_id>/active`; `POST /lobbies/game/<game_id>/concede`.
- Hearts records: `GET /stats`; POST `/stats/{record,unlock}`; `GET /stats/by-category`; GET/PATCH `/preferences`; `GET /leaderboard`; `POST /leaderboard/reset-month`.
- Euchre records: `POST /account/euchre/results`; GET `/account/euchre/{leaderboard,multiplayer-results}`.

Incoming socket registrations, all still using the transport path `/socket.io`:

- `/game`: connect, disconnect, advance, play.
- `/lobby`: connect, disconnect, join, leave, close_lobby, start_game.
- `/multi`: connect, disconnect, request_state, pass, play, concede.
- `/euchre`: connect, disconnect, command. Command types retain their existing payloads and acknowledgements.

## Tables, privileges, and migration bootstrap

Intended eventual ownership, with current access retained for this slice:

- Accounts: `users`, `account_sessions`, `password_reset_tokens`. Verification data currently lives on `users`.
- Hearts: `active_games`, `user_stats`, `user_preferences`, `difficulty_stats`, `game_results`.
- Euchre: `euchre_tables`, `euchre_game_results`.
- Game tables reference `users.id`; Euchre snapshots also embed participant account IDs. Local account deletion temporarily writes both games' tables. Leaderboard queries temporarily read user names/icons directly.

All roles still initialize the same SQLAlchemy metadata and use the configured database credentials. No grants or credentials change here. Future runtime roles must restrict account access to the account owner, game writes to their respective tables, and migration privileges to a separate serialized migration job. Resolve profile joins, foreign-key access, and deletion coordination before removing temporary access.

The unchanged legacy Alembic chain is linear, `001` through `019`, using `alembic_version`. It bootstraps users (`001`), username (`002`), Hearts totals/active games/preferences (`003`–`005`), achievement/multiplayer/stat/profile/result additions (`006`–`016`), shared sessions and auth version (`017`), Euchre results (`018`), and Euchre tables (`019`). Existing revision scripts remain the authoritative schema history.

`flask --app hearts:app db heads` still resolves to `019`. No migration is added, copied, stamped, upgraded, or downgraded on a deployed database by this work. The actual production revision and restored-database bootstrap must be checked in the later approved rehearsal before assigning independent migration ownership.

## Background work inventory

- Hearts lobby: 20-minute lazy lobby expiry and 30-second host/guest disconnect callbacks. Callbacks now enter the originating application context.
- Hearts multiplayer: 120-second reconnect window, 540-second idle warning, 600-second idle removal, 30-minute stale-game cleanup, and bot continuation. Existing application/context capture remains intact; runtime maps are now app-owned.
- Euchre: 30-second disconnection grace, 20-minute lazy table expiry, and revision-checked bot/trick jobs. The originating app and socket server are passed explicitly at registration.
- Accounts: bounded two-worker email queue, 32 pending slots, existing session/token expiry checks, and password recovery revocation. Email workers already retain their originating app; queue capacity remains process-wide.

## Verification

The API regression suite covers both games and current account behavior. New tests cover role registration, deployed-surface compatibility, lazy imports, independent databases/runtime state/rate limits, background context ownership, immutable account records, injected deletion, and unavailable-account HTTP/socket behavior. The existing Euchre browser/server parity script continues to verify game transitions.
