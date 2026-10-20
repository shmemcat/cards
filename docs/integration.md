# Shared Cards accounts and hosting

## Implemented locally

The shared account service lives in the existing Hearts Flask API. It reads the
same users and Argon2 password hashes, preserving IDs, verification status,
profiles, preferences, and Hearts statistics. All three sites use one cookie
session. Euchre games, stats, and achievements remain browser-local; shared
identity does not upload or merge those results.

The hub `/user/` handles registration, verification, recovery, and login. Hearts'
existing forms also use the shared service when enabled. Euchre links to the hub
for account creation and recovery. All three refresh identity when focused, and
logout revokes the server session.

The API exposes `/account/session`, `/account/login`, `/account/logout`,
`/account/register`, `/account/verify-email`, `/account/resend-verification`,
`/account/forgot-password`, and `/account/reset-password`. Browsers reach it through
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
   deployment. Migration **017** adds `users.auth_version` default 0 and
   `account_sessions`; it does not rewrite users, passwords, profiles, or stats.
3. Set API `CARDS_PUBLIC_URL=https://cards.shmem.dev`,
   `FRONTEND_URL=https://cards.shmem.dev`, `CORS_ORIGINS=https://cards.shmem.dev`.
   Retain the existing `DATABASE_URL`, `JWT_SECRET`, SMTP2GO key, and verified sender.
   Keep credentials in server configuration.
4. Build Hearts with `VITE_SHARED_ACCOUNTS=true`. Production defaults retain its
   legacy frontend until enabled; Compose forwards the flag to Vite. Build Euchre
   with `VITE_ACCOUNT_API_URL=/api/account`.
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

## Intended public routes

- `cards.shmem.dev/`: hub.
- `/user/`: shared accounts.
- `/hearts/`: Hearts and its assets/client routes.
- `/euchre/`: Euchre built with `VITE_BASE_PATH=/euchre/`.
- `/api/`: Hearts API, including shared accounts.
- Hearts Socket.IO paths: explicitly proxy them to the Hearts game service.

Keep all three repositories. Game prefixes, Hearts base-path changes, and final
reverse-proxy configuration remain hosting work. Local game redirects are only
for development. Preserve paths and queries when redirecting old game subdomains
after the new routes work. Browser-local saves and themes need a migration/export
plan before changing origins; hosting changes do not move browser storage.
