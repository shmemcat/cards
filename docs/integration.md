# Shared Cards accounts and hosting

The staged server separation now has local [game routing compatibility changes](game-routing-compatibility.md).
Release those gateway aliases before releasing clients using the new paths.
Both games continue to use the existing combined API until their later cutovers.

## Implemented locally

The shared account service lives in the existing Hearts Flask API. It reads the
same users and Argon2 password hashes, preserving IDs, verification status,
profiles, preferences, Hearts games, and statistics. All three sites use one
cookie session. Completed account-owned Euchre bot results sync to a separate
leaderboard table; guest results are not assigned to an account. In-progress
Euchre games and its personal dashboard remain browser-local.

The hub `/user/` handles registration, verification, recovery, and login. Hearts'
existing forms also use the shared service when enabled. Euchre links to the hub
for account creation and recovery. All three refresh identity when focused, and
logout revokes the server session.

The API exposes `/account/session`, `/account/login`, `/account/logout`,
`/account/register`, `/account/verify-email`, `/account/resend-verification`,
`/account/forgot-password`, `/account/reset-password`, `/account/profile`, and
`/account/delete`. Euchre uses `/account/euchre/results` and
`/account/euchre/leaderboard`. Browsers reach the service through
`/api/account/`. Responses contain user details and a CSRF token, never a session
credential. Mutations require CSRF and an allowed Origin. Responses are uncached.
Recovery links expire after one hour, verification after 24 hours. Password reset
is single-use and revokes all sessions and legacy JWTs for that account.
HTTPS uses a host-only `__Host-cards_session` cookie with Secure, HttpOnly,
SameSite=Lax, and Path=/.

## Live account cutover

The local runner performs no production migration or deployment.

1. Back up the live Hearts PostgreSQL database and verify restoration in staging.
   Keep existing IDs and password hashes. Do not replace it with the fresh Cards
   SQLite database.
2. Run `flask db upgrade` against a restored staging copy, then against live during
   deployment. Migrations **017–019** add `users.auth_version` default 0,
   `account_sessions`, `euchre_game_results`, multiplayer result counters and
   `euchre_tables`; they do not rewrite existing
   users, passwords, profiles, Hearts games, or statistics.
3. Set API `CARDS_PUBLIC_URL=https://cards.shmem.dev`,
   `FRONTEND_URL=https://cards.shmem.dev`, `CORS_ORIGINS=https://cards.shmem.dev`.
   Retain the existing `DATABASE_URL`, `JWT_SECRET`, SMTP2GO key, and verified sender.
   Keep credentials in server configuration.
4. Build the gateway in `deploy/Dockerfile`, Hearts with
   `VITE_SHARED_ACCOUNTS=true` and `VITE_BASE_PATH=/hearts/`, and Euchre with
   `VITE_BASE_PATH=/euchre/` and `VITE_ACCOUNT_API_URL=/api/account`.
   Their release workflows supply these build settings.
5. Route `/api/` to the Hearts API, stripping `/api` as the development proxies do.
   Forward cookies and Origin unchanged, keep account responses uncached, and use
   HTTPS. Keep `/user/` on the hub. Preserve old verification/reset URLs or redirect
   them to the matching hub flow.
6. Verify real email delivery, recovery, shared login/logout, existing profiles and
   stats, gameplay, and Hearts sockets on the final host before permanent redirects.
   Mail queue delivery is best-effort; a worker restart can interrupt queued mail,
   so retain resend/recovery controls and monitor provider failures.

Legacy Hearts JWTs continue to validate until expiry or password reset. Tokens
on `hearts.shmem.dev` do not transfer to `cards.shmem.dev`; players sign in once at
the new home with the **same account and password**. The final host-only cookie
does not share credentials with arbitrary `shmem.dev` subdomains.

## Implemented production routes

- `cards.shmem.dev/`: hub.
- `/user/`: shared accounts.
- `/hearts/`: Hearts and its assets/client routes.
- `/euchre/`: Euchre built with `VITE_BASE_PATH=/euchre/`.
- `/api/`: Hearts API, including shared accounts.
- `/socket.io/`: Hearts game service, including WebSocket upgrades.

`deploy/nginx.conf` strips each game prefix and proxies to its own web container;
each game handles deep links and missing-asset 404s. The gateway blocks hidden
files and development mail. It proxies
the account/game API and sockets. Old subdomains preserve paths and queries;
old verification/recovery links reach the matching hub form. Keep HTTPS and DNS
for those old names. Local game redirects remain development-only.

Browser-local saves and themes do not transfer between origins. Account-owned
data in PostgreSQL is preserved; existing players sign in once at the new home.

## Actual infrastructure and release

The authoritative infrastructure checkout is the sibling `infra` repository at
`https://forge.nuttynet/nuttyverse/infra.git`. GitHub is its push mirror. Use
GPG-signed commits and the required Forgejo review before applying changes.
The full operator sequence is documented in **infra/docs/cards.md**.

Nuttygate (`5.78.127.247`) runs public Caddy and forwards through WireGuard to
nuttybox. Nuttybox runs Podman and PostgreSQL 18. The existing database is
**shmemcity**, schema **hearts**, stored at `/data/postgresql`. Preserve the
existing DATABASE_URL including its schema search path. This is not a Docker
database volume. Keep the encrypted `/run/secrets/hearts-environment` unchanged.

The infra modules upgrade the existing API, retain its `api` network alias, add
`cards-api`, and expose only the Cards gateway at `10.100.0.2:6667`.
The two game web containers have no host ports. The gateway resolves container
names through Podman DNS at `10.6.0.1`, including after automatic restarts. The old Hearts web
app remains at 6666 for rollback. The API trusts exactly two private proxies;
the public edge overwrites incoming forwarding headers.

Each repository has a **Release** workflow triggered by pushed `v*` tags (for
example `v1.2.3`). A manual run takes an existing version tag and checks out that
exact tag. Cards publishes `ghcr.io/shmemcat/cards-web`, Euchre publishes
`euchre-web`, and Hearts publishes `hearts-api`, `hearts-web` (legacy root), and
`hearts-cards-web` (shared login under `/hearts/`). Workflows test sources before
publishing versioned images and then promoting `latest`. Hearts finishes all
three versioned builds before promotion, but separate containers update in turn;
this is not an atomic deployment. Preserve compatibility with the previous API
and frontend during releases. Ordinary branch commits do not deploy.

Hearts and Euchre each require `FONTAWESOME_PACKAGE_TOKEN` in their own Actions
secrets. It is supplied through BuildKit secrets, never Docker build arguments.
Cards no longer needs that token. No cross-repository source token is needed.
Nuttybox has no GHCR login: make all four Cards image packages publicly pullable
before activation, or configure reviewed private registry credentials. Public
source repositories alone do not guarantee public package visibility.

With `shmem.cards.enable = true`, the existing Podman timer checks all four images
every minute. Registry labels opt containers in; health checks and
`sdnotify=healthy` wait for startup and permit Podman's failed-start rollback.
A failed initial health check does not validate all game or account flows, and
image rollback does not undo database migrations. The gateway dynamically
resolves upstream addresses so it follows recreated containers.

Before deployment, pause account/game writes, take a root-only live Hearts schema
backup, and verify an isolated restore. With the new image and existing database
environment, run `python -m hearts.account_snapshot snapshot` before migration
and `python -m hearts.account_snapshot verify -` afterward with the saved JSON on
stdin. It outputs only columns, row counts, and digests. Retain existing secrets.

Before the first Hearts version release, stop the existing automatic updater
for the maintenance window: its live API already follows `hearts-api:latest`.
Confirm no update job is running. Publish and verify the reviewed image versions
while updates are paused, then follow **infra/docs/cards.md** for migration and
HTTPS checks. Restart the updater only after these pass.

After DNS and the reviewed gateway config are ready, set
`shmem.cards.enable = true;` on nuttybox. It defaults to false. For the first
cutover, set `shmem.cards.autoUpdate = false;` and pin all four
`shmem.cards.images.{api,gateway,hearts,euchre}` to reviewed version tags or digests.
After verification, remove pins and enable `autoUpdate` to follow future tags.
Then enable `shmem.cards.redirectLegacy = true;` on nuttygate. Emily's gateway
deployment requires her sudo password. The old Hearts redirect defaults to false.

For rollback, disable `autoUpdate` and pin a previous compatible image using the
same image options, then apply the reviewed configuration. Restore old Hearts
routing if necessary. Leave additive schema changes in place; do not restore a
stale backup over newer account/game writes as a routine rollback.

## DNS and SMTP2GO

Porkbun needs A records **cards → 5.78.127.247** and **euchre → 5.78.127.247**,
TTL **600**. Keep the existing Hearts A record. Explicit records override the
parked wildcard. Caddy obtains HTTPS certificates automatically.

SMTP2GO already shows **shmem.dev verified**, tracking enabled, and the existing
**Hearts** API key enabled with email-send permission. Production already has a
key configured and uses `noreply@shmem.dev`. Reuse it; its description does not
restrict the website URL. No new sender or key is required. Keep these CNAMEs:

- `em1070355.shmem.dev` → `return.smtp2go.net`
- `s1070355._domainkey.shmem.dev` → `dkim.smtp2go.net`
- `link.shmem.dev` → `track.smtp2go.net`

Keep Porkbun's existing forwarding MX/SPF records. Password login does not send
mail; registration, verification, email changes, and recovery do. Final real
email delivery still needs the HTTPS-host test. Provider rejections are now
detected even on HTTP 200, without logging private token links.

## Rehearsal completed

On 2026-10-21, an approved read-only live dump was restored into isolated,
RAM-backed PostgreSQL 18 and migrated **016 → 018**. Original-column fingerprints
matched across all **10 users**, 9 stats rows, 5 preference rows, 27 difficulty
stats, 99 game results, and 32 active games. Production was untouched.

Synthetic accounts passed registration, verification, shared login, CSRF,
profile/preferences, Hearts game creation, recovery and replay rejection, email
change, and logout/revocation using file-only mail. The read-only
`node scripts/check-deployment.mjs http://localhost:3096` check covers combined
routes, assets, deep-link refresh, old redirects/queries, the API, and Socket.IO.
Remove the isolated restored database and private test mail after the rehearsal.
