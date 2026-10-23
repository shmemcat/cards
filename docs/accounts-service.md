# Cards accounts service: local implementation and activation runbook

Phase 3 extracts accounts into `cards/api/`. It does not activate another
production writer, change gateway upstreams, or change the default combined
Hearts entrypoint. The game extraction and reviewed infrastructure cutover remain
later phases. The account image/workflow are prepared; publishing requires an
explicit `accounts-vX.Y.Z` tag. There is no moving `latest` account tag.

## Ownership

Accounts owns `users`, `account_sessions`, `password_reset_tokens`,
`account_deletion_requests`, `account_id_sequence`, and
`cards_accounts_alembic_version`. Only accounts receives the existing JWT signing
secret, password hashes, recovery/session credentials, and mail credentials.
It imports no Hearts package and registers no game routes or sockets.

Hearts retains `active_games`, `user_stats`, `difficulty_stats`, `game_results`,
and `user_preferences`. Euchre retains `euchre_tables` and
`euchre_game_results`. Their supplemental deletion receipts/version tables are
`hearts_account_deletions`, `hearts_account_schema_version`,
`euchre_account_deletions`, and `euchre_account_schema_version`.
Game runtime requests fetch public identities remotely and do not read account
tables. The legacy ORM definitions still exist in the transitional package;
removing those definitions/imports belongs to the game package extraction.

Use separate PostgreSQL roles at activation: accounts gets CRUD on its owned
tables and its user ID sequence; each game gets CRUD and sequence access only
for its own game/receipt tables. A migration role provisions schema/version
tables and owns cross-table foreign-key creation. Revoke inherited/default
privileges that otherwise allow game reads of account tables. The combined
transition worker temporarily needs both games' privileges. Never give it
account table access simply to make a failed runtime query work.

## Configuration

The accounts process uses `DATABASE_URL`, the **existing** `JWT_SECRET`,
`CARDS_PUBLIC_URL` (the existing public HTTPS origin), `CORS_ORIGINS`, and
`TRUSTED_PROXY_HOPS`. It retains the cookie name, Path `/`, HttpOnly, SameSite
Lax, secure-cookie behavior, existing IDs, hashes, and revocation rules.
Production mail uses `SMTP2GO_API_KEY` and `SMTP2GO_FROM_EMAIL`. Local tests use
`CARDS_EMAIL_TRANSPORT=file` and a private `CARDS_EMAIL_OUTBOX`; this transport
is rejected for a nonlocal public origin.

`CARDS_INTERNAL_CLIENTS` is a JSON object keyed by calling service ID. Each value
contains a distinct random `token` (at least 32 characters) and explicit
`scopes`, chosen from `sessions.validate` and `profiles.read`. During this slice,
the combined game process uses the `combined-games` principal. Dedicated games
will receive different principals/keys. A profiles-only key cannot validate a
session, and these keys cannot mutate accounts.

`CARDS_GAME_SERVICES` maps `hearts` and `euchre` to `{ "url": "http://private-game:5000",
"token": "separate-accounts-to-game-key" }`. During the transition both origins
can point to the **one** combined game worker, using different callback keys.
Values are private HTTP(S) origins without credentials, paths, or query strings.
Keep them on the private container network; use TLS if the network is untrusted.

Opt a game process into remote accounts with `CARDS_ACCOUNTS_URL`,
`CARDS_SERVICE_ID`, `CARDS_SERVICE_TOKEN`, and JSON
`CARDS_GAME_ACCOUNT_TOKENS` (game name to matching callback key).
With no remote URL, the current local combined account implementation remains
the default. No deployment manifest or existing migration startup was changed.
Configured combined mode relays a fixed whitelist of existing public account
URLs to accounts, preserving response cookies and CSRF behavior. It cannot relay
arbitrary private paths. Game-only factories do not own public account routes.

## Private v1 contract

Calls require `X-Cards-Service` and a scoped `Authorization: Bearer` service key.
Browsers must never receive these keys. The gateway, standalone Nginx servers,
Node preview, and both development proxies reject `_internal` path segments,
including encoded forms. Nginx rejects nested path escapes to prevent another
upstream from decoding them into private paths.

- `POST /_internal/accounts/v1/session`: validates forwarded Cookie, Origin, and
  X-CSRF-Token; returns `version: 1`, `user`, `session`, `valid_origin`, and
  `valid_csrf`. A user contains only integer `id`, `username`, `profile_icon`,
  and boolean `email_verified`. A session contains only `csrf_token`.
- `POST /_internal/accounts/v1/legacy`: accepts `{token}` in the JSON body and
  returns `version` and the same public identity or null. Only accounts verifies
  the existing JWT signing secret/auth version.
- `POST /_internal/accounts/v1/profiles`: accepts `{user_ids}` (at most 500
  positive integer IDs) and returns public `profiles`. Pending-deletion users
  are omitted. No emails, hashes, password/reset tokens, or signing secrets are
  included in private replies.
- `POST /_internal/games/v1/hearts/preferences`: accounts authenticates to Hearts
  with its separate callback key and `{user_id}`. Returns game-owned preferences.
  An unavailable/malformed reply makes the public account response explicitly
  report `preferences_available: false`. Hearts keeps browser preferences and
  suppresses automatic preference uploads in that case.
- `POST /_internal/games/v1/{game}/delete-user`: accounts sends `{user_id,
  request_id}`; request ID is a 32-character lowercase hex UUID. A completed
  response contains `version: 1`, `deleted: true`, and that request ID. Receipts
  make repeated cleanup safe, including after a restart.

Private calls prohibit redirects, ignore ambient HTTP proxy settings, cap
response sizes, and use two-second network timeouts. Unsupported contracts,
malformed replies, and transport failures are unavailable-service errors.
Public account relays have a six-second timeout to cover both game callbacks.
Unknown future v2 endpoints return 404; keep v1 available through the documented
client compatibility window rather than changing its meaning in place.

## Deletion and game safety

Deletion first commits a durable job, increments auth version, removes sessions
and reset links, and blocks further account identity/profile/login use. Both
games scrub results/preferences/stats, active and persisted snapshots, account
links, participant names/icons, and recoverable seat credentials. Humans become
bots or leave waiting seats. Persistent tombstones prevent stale authenticated
requests from recreating deleted data. Games never delete `users` themselves.

Only after both cleanup acknowledgements and successful foreign-key-safe user
deletion does accounts return 200. Otherwise it returns **202** with
`code: DELETION_PENDING`, an anonymous session/CSRF token, and an honest
processing message. All three account UIs display that message. The account
WSGI worker retries durable jobs automatically (bounded batches/backoff/leases);
`python -m cards_accounts.schema retry-deletions` is an explicit retry command.
Check pending jobs and logs if an unknown foreign-key dependency prevents final
deletion. Do not remove a dependency or fake an acknowledgement blindly.
Receipts contain only IDs, request IDs, and timestamps; they remain to fence
stale writers. SQLite uses a monotonic account ID allocator to avoid recycling
a deleted identity. PostgreSQL retains its existing user sequence.

The transition still uses **one eventlet game worker**, with a greenlet-aware
write gate. Identity/profile validation happens before acquiring the gate;
private cleanup and authoritative mutations share it. Signed socket commands
revalidate their original account and fail on revocation. An outage yields
`ACCOUNTS_UNAVAILABLE`, never a silent signed-in-to-guest conversion. Existing
guest sockets can continue, while unvalidated cookies fail closed. Signed-player
idle/disconnect expiry pauses during account-service outages. The accounts
process uses one threaded Gunicorn worker and no Socket.IO dependency.

## Schema preparation and activation order

1. Back up and rehearse against an isolated restored PostgreSQL database with
   file-only mail. Verify the deployed legacy revision is **019** and record
   account/game fingerprints before running migrations.
2. Before activating remote mode, drain legacy Hearts multiplayer games and
   waiting lobbies. Old snapshots lack durable account-seat links; never infer
   identity by display name. Remote game readiness refuses persisted multiplayer
   snapshots without `account_links_version: 1`.
3. Run `python -m cards_accounts.schema upgrade` using migration credentials.
   Fresh accounts-only databases are supported; existing legacy game databases
   must be at 019. The additive migration verifies existing columns, preserves
   account records, and uses `cards_accounts_alembic_version=accounts_001`.
4. Provision supplemental game receipts with
   `python -m hearts.game_accounts upgrade` under migration credentials, with
   the intended remote-mode configuration. The explicit migration can repair
   orphaned legacy Euchre account links using account IDs; this is the only
   temporary account-table read in game provisioning. It never runs in request
   handlers. Each game gets its own version table. PostgreSQL migration jobs
   take advisory locks. Do not run this concurrently with an active game writer.
5. Verify `python -m cards_accounts.schema check` and the game schema check.
   The account image starts without migrating. A later split-game container
   must likewise check schema instead of copying the legacy startup migrator.
6. In the separately reviewed cutover, stop the old account writer before
   enabling accounts and remote-mode games with reduced runtime roles. Preserve
   the existing database, cookie origin, and JWT key. Do not start two game
   owners/timer processes against the same tables. Route account traffic only
   after the adapters and proxy boundary are available.

`/health` identifies the account component, image version, and source revision.
`/ready` additionally checks required configuration, schema ownership, and peer
configuration; it does not cascade peer outages into process restarts. Game
remote-mode readiness checks receipt revisions and the legacy-game drain.
Readiness is not proof of PostgreSQL grants or successful external mail delivery.
Do not use image rollback as a schema downgrade. Completed distributed deletions
cannot be undone by returning to the old account code; a rollback must preserve
revocation/tombstones and the single-writer rule.

## Verification

From `cards/api/`, `uv sync --locked --extra dev` and `uv run --locked pytest -q`
test the independent service, existing credentials, private scopes, revocation,
schema preservation, pending cleanup, retries, and unavailable preferences.
No sibling checkout is needed for those tests or the accounts image.

With both game checkouts/dependencies available, run `npm run test:accounts`
from Cards for a disposable SQLite rehearsal with **separate account and game
processes**, actual HTTP requests, and JavaScript Socket.IO clients. It covers
shared login, both games, CSRF, logout/expiry/reset, an account-process restart,
guest continuity, pending deletion, and retry scrubbing. It rejects any game
runtime SQL access to account-owned tables and any account RPC under the game
write gate. `npm run test:routing` additionally exercises actual Nginx, Node, and
Vite proxies, including intentionally reachable private backend probes that
must be blocked publicly. Neither suite reads production data.

Cards `npm run test:postgres` now builds and runs all four split images against
disposable PostgreSQL 18, verifies runtime grants, and restores synthetic legacy
`019` data into another database's `hearts` schema. Repeated additive migrations
preserve the seeded account/session/recovery and game fingerprints. Actual
production-backup restoration, published-image integration, image publishing,
and production activation remain distinct steps. See [component releases](component-releases.md)
for the repeatable rehearsal and verification limits.

Both the [independent Euchre server](../../euchre/api/README.md) and [independent Hearts server](../../hearts/game-api/README.md) now implement the private account callbacks. For these separate runtimes, provision `python -m euchre_server.schema upgrade` and `python -m hearts_server.schema upgrade` explicitly, after accounts and before runtime startup. They use `euchre_alembic_version=euchre_001` and `hearts_alembic_version=hearts_001`, retaining the phase-three cleanup receipt versions. Do not run the combined migrator from either game container.

Cards `npm run test:hearts-server` (or `test:euchre-server`) exercises all three independent processes, completed matches and persisted recovery in both games, spectator privacy, legacy authentication, outage/revocation behavior, and pending deletion/retry with Hearts offline. Current deployment callback destinations remain unchanged.

The [published-image production-restore rehearsal](../release/rehearsals/production-restore-2026-10-22/README.md) now also passes: the read-only `019` production dump preserves all original account/session/recovery and game columns through repeated migrations and cold startup. Existing-account reads and all 31 Hearts saves work through the split services. The functional probe records normal expired-session/lobby cleanup separately and rejects loss or changes to valid sessions. The [restore runbook](production-restore-rehearsal.md) documents the repeatable command and disposal of restored data; production activation remains separate.
