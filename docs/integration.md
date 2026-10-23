# Shared Cards accounts and hosting

Production runs separate accounts, Hearts and Euchre services with shared accounts.
Local `npm run dev` uses the same ownership split and isolated local data; see
[component releases](component-releases.md). Legacy publishing is
[manual-only](legacy-releases.md). The original account-adoption sections below
are historical context, not a procedure to rerun against the current deployment.

## Original shared-account implementation (historical)

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

## Original account cutover (historical)

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

## Current infrastructure and release

Infra's authoritative repository is `https://forge.nuttynet/nuttyverse/infra.git`.
The normal `nuttybox` target runs separate `cards-accounts-api`, `hearts-game-api`,
and `euchre-game-api` owners, a gateway and two frontend containers. Public Caddy
on Nuttygate forwards through WireGuard to the private gateway. PostgreSQL 18
retains the `shmemcity` database and `hearts` schema, with separate runtime roles.
Game processes use private scoped account interfaces rather than account tables.

Component release workflows publish immutable candidates and source/digest
records. They do not migrate or deploy production. Legacy `v*` publication now
requires manual dispatch and acknowledgement; it does not update `latest`.
Hearts and Euchre frontend builds still need their own Font Awesome package
secret. No cross-repository source token is required.

Production pins are reviewed in Infra's
`nuttybox/containers/cards-split/activation-images.json`. Cards containers have no
auto-update labels; the host updater remains available for unrelated services.
Returning to the combined owner requires `nuttybox-cards-rollback` and its drain,
deletion and database handoff guards. Preserve existing rollback artifacts and
credentials; never restore an old backup over later writes for a code rollback.
See Infra's `docs/cards-split-default.md`, `docs/cards-split-cutover.md`, and
`docs/cards-operations.md` for the current operator procedures.

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

On 2026-10-22, the [split-service production-restore rehearsal](../release/rehearsals/production-restore-2026-10-22/README.md) passed against a fresh read-only dump of the current `019` schema, using the published immutable image pins. All original columns across 11 tables matched through repeated service migrations and cold startup, and all 31 restored Hearts solo saves opened. Runtime grants, existing account data, independent component replacement, and deletion passed. One expired lobby and one expired anonymous session were removed by normal housekeeping only in the isolated copy. Production containers, updater, image digests, and data were unchanged; the restored database and test mail were removed. Repeat the backup/current-state checks at the separately reviewed cutover.
