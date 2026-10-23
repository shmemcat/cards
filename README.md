# Cards

The home for shmemcat's Hearts and Euchre sites. Each game link keeps its own
logo, font, palette, and glossy button. Both light and dark themes are supported.

## Run locally

Requires Node.js 22.12+. The hub has no npm dependencies. Keep the `cards`,
`hearts`, and `euchre` repositories beside each other.

Start the hub and shared account API together:

```powershell
npm run dev
```

The API uses the Hearts API's Python environment at
`../hearts/api/.venv/Scripts/python.exe` (or `.venv/bin/python` on Unix).
Install Hearts API dependencies first if that environment does not exist.
`HEARTS_API_PATH` and `HEARTS_PYTHON` can override those paths.
The runner creates **Cards/.local/accounts.sqlite** for development. It does not
load a live database or copy users from another machine.

Open **http://localhost:3000/**. Start Hearts and Euchre frontends separately
on ports **3001** and **3002**. Use `localhost` for all three: cookies are shared
between its ports, while saves and theme storage remain specific to each port.
The hub redirects `127.0.0.1` to `localhost` in development.
The account API starts automatically and is ready before the hub starts. If a
shared account API is already running, the hub reuses it. Stopping the command
also stops the services it started. The local account API reloads when its Python
source changes. Restart an API launched before auto-reloading was enabled once
to pick up the current routes. `npm run dev:hub` runs only the hub and
`npm run dev:accounts` runs only the account API when separate terminals are useful.

The server proxies `/api/` and the legacy/new socket paths to
`http://127.0.0.1:5000/`. Game calls use `/api/hearts/` or `/api/euchre/`;
accounts keep `/api/account/`. Set `CARDS_API_TARGET` for a different combined API.
Game links temporarily redirect to local games; override with
`HEARTS_LOCAL_URL` and `EUCHRE_LOCAL_URL` if needed. When using Hearts' Docker API
instead of `dev:accounts`, migrate its database and set
`CARDS_API_TARGET=http://127.0.0.1:5001/`. Use one account API for all sites.

## Accounts and recovery

`/user/` offers sign-in, registration, email verification, password recovery, and
logout. Both games recognize the same session. Authentication uses an HttpOnly
cookie; no login tokens are stored in browser storage or passed in game links.

The local runner defaults to an email sandbox at **.local/outbox/**, including
when a provider key is present. It can reuse only `SMTP2GO_API_KEY` and
`SMTP2GO_FROM_EMAIL` from Hearts' root `.env` when explicitly enabled. The current
local workflow keeps the sandbox until deployment:

```powershell
$env:CARDS_EMAIL_TRANSPORT='file'
npm run dev:accounts
```

Open **http://localhost:3000/__dev/mail/** for local verification and recovery
emails, then follow the matching link. Refresh the inbox after requesting a new
email. This inbox is available only in development over a loopback connection;
the production and built-preview server do not expose it.
The `url` in each generated JSON email also works directly.
These files contain private temporary links and stay ignored by Git. File delivery
is prohibited on public hosts. Set `CARDS_EMAIL_TRANSPORT=smtp2go` explicitly and
restart to opt into real local email delivery with a configured key.
Provider delivery uses a bounded background queue; errors are logged by the API
and users can request another link.

Live Hearts accounts are preserved by deploying the API against the **existing
live Hearts database**, then applying migrations **017–018**. The local database is
separate. See [deployment and migration notes](docs/integration.md).

## Build and checks

```powershell
npm run build
npm run preview
```

`dist/` contains static files. The Node preview also proxies `/api/`; another
static host needs its own API routing. The production gateway in `deploy/` serves the hub, proxies independently built
games at `/hearts/` and `/euchre/`, and handles old subdomain redirects. It is separate from this local development server.
Account tests live in `../hearts/api/tests/test_shared_accounts.py`.

`npm run test:routing` checks real HTTP/Socket.IO traffic through the gateway
rules and development proxies using a disposable backend. It requires local
Nginx (`NGINX_BIN` if not on PATH) and the sibling projects' dependencies.
See [routing compatibility and release order](docs/game-routing-compatibility.md).

## Production

The intended home is **https://cards.shmem.dev/**, with both games and one login
on the same origin. Push a version tag such as `v1.2.3` in the relevant repo:
Cards publishes `cards-web`, Euchre publishes `euchre-web`, and Hearts publishes
`hearts-api`, `hearts-web`, and `hearts-cards-web` to GHCR. Successful workflows
publish versioned images and promote `latest`. Each game builds its own code;
no cross-repository access token is needed. Hearts and Euchre each need the
`FONTAWESOME_PACKAGE_TOKEN` Actions secret. The hub needs no package token.

After the first reviewed cutover, Podman's existing updater checks every minute
and restarts changed containers. Health checks gate startup and allow rollback
on failed starts. These are rolling updates; keep API changes backward compatible
with the previous frontend. The first account migration still requires the
backup and verification sequence below before publishing a Hearts release.

The actual host uses NixOS, Podman, and the existing PostgreSQL `shmemcity`
database's `hearts` schema. Infrastructure changes live in the sibling `infra`
checkout, whose authoritative origin is Forgejo. Follow the
[deployment runbook](docs/integration.md) before enabling the release or redirects.
Never deploy `scripts/account-dev.py` or `.local/accounts.sqlite` to production.

For an isolated local rehearsal, `deploy/compose.verify.yml` provides RAM-backed
PostgreSQL and file-only email. Against a running gateway, use:

```powershell
node scripts/check-deployment.mjs http://localhost:3096
```

## Assets

Logos and fonts are reused from Hearts and Euchre. License notices are in
`public/assets/`. The navbar uses the games' three licensed Font Awesome Pro
icons as bundled SVGs. No package-install token is needed for the hub.

The independently packaged [Cards accounts API](api/README.md) and [activation runbook](docs/accounts-service.md) are prepared locally; production routing and the default combined backend remain unchanged.

The [Hearts game server](../hearts/game-api/README.md) and [Euchre game server](../euchre/api/README.md) are also independently packaged. With their environments installed, `npm run test:hearts-server` (alias `test:euchre-server`) runs a disposable three-service rehearsal covering shared accounts, full games, recovery, deletion retry, and restarts that leave the other game connected. These commands do not change the default development or deployment destinations.

Use `npm run dev:split` for the opt-in local stack with all three separate backends and both web apps. Backend releases use separate component tags and digest records, while existing `v*` workflows retain their current behavior. See [component releases and local integration](docs/component-releases.md) for setup, tests, pinned-image CI, and promotion/rollback manifests.

The published images also pass an [isolated production-restore rehearsal](release/rehearsals/production-restore-2026-10-22/README.md). The [restore runbook](docs/production-restore-rehearsal.md) describes `npm run test:production-restore`, which streams an approved read-only dump into disposable PostgreSQL and preserves the current deployment.
