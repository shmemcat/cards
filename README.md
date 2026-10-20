# Cards

The home for shmemcat's Hearts and Euchre sites. Each game link keeps its own
logo, font, palette, and glossy button. Both light and dark themes are supported.

## Run locally

Requires Node.js 22.12+. The hub has no npm dependencies. Keep the `cards`,
`hearts`, and `euchre` repositories beside each other.

Start the shared account API in one terminal:

```powershell
npm run dev:accounts
```

It uses the Hearts API's Python environment at
`../hearts/api/.venv/Scripts/python.exe` (or `.venv/bin/python` on Unix).
Install Hearts API dependencies first if that environment does not exist.
`HEARTS_API_PATH` and `HEARTS_PYTHON` can override those paths.
The runner creates **Cards/.local/accounts.sqlite** for development. It does not
load a live database or copy users from another machine.

Start the hub in another terminal:

```powershell
npm run dev
```

Open **http://localhost:3000/**. Start Hearts and Euchre frontends separately
on ports **3001** and **3002**. Use `localhost` for all three: cookies are shared
between its ports, while saves and theme storage remain specific to each port.
The hub redirects `127.0.0.1` to `localhost` in development.

The server proxies `/api/` to `http://127.0.0.1:5000/`. Set `CARDS_API_TARGET` for
a different API. Game links temporarily redirect to local games; override with
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

Open the `url` from a generated JSON email to verify or reset a local test account.
These files contain private temporary links and stay ignored by Git. File delivery
is prohibited on public hosts. Set `CARDS_EMAIL_TRANSPORT=smtp2go` explicitly and
restart to opt into real local email delivery with a configured key.
Provider delivery uses a bounded background queue; errors are logged by the API
and users can request another link.

Live Hearts accounts are preserved by deploying the API against the **existing
live Hearts database**, then applying migration **017**. The local database is
separate. See [deployment and migration notes](docs/integration.md).

## Build and checks

```powershell
npm run build
npm run preview
```

`dist/` contains static files. The Node preview also proxies `/api/`; another
static host needs its own API routing. Final game mounts and subdomain redirects
belong to the hosting cutover and are not enabled by local development.
Account tests live in `../hearts/api/tests/test_shared_accounts.py`.

## Assets

Logos and fonts are reused from Hearts and Euchre. License notices are in
`public/assets/`. The navbar uses the games' three licensed Font Awesome Pro
icons as bundled SVGs. No package-install token is needed for the hub.
