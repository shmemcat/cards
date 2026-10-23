# Cards

The home for Hearts and Euchre, with shared accounts and separate game servers.
Production runs at **https://cards.shmem.dev/**.

## Run locally

Keep the `cards`, `hearts`, and `euchre` repositories beside each other. Install
Node.js 22.12+, Python 3.11 and uv. From Cards, install the integration dependencies
and the three backend environments:

```powershell
npm ci --ignore-scripts
uv sync --project api --locked --extra dev
uv sync --project ../hearts/game-api --locked --extra dev
uv sync --project ../euchre/api --locked --extra dev
```

Install each game's frontend dependencies using `npm run web:install` in that
game's repository. Its root `.env` supplies the Font Awesome package token for
installation. Keep tokens out of Git.

```powershell
npm run dev
```

This is the default split stack: the hub on port 3000, Hearts and Euchre web apps
on 3001/3002, and accounts/Hearts/Euchre backends on 5100/5101/5102. The game
repositories' root `npm run dev` delegates to this same runner. Run it once and
open **http://localhost:3000/**. `npm run dev:split` remains an alias in Cards.

The runner uses only **cards/.local/split-dev/** for its SQLite database, stable
local keys and mail outbox. It refuses occupied ports and inherited database or
service settings. It never adopts `.local/accounts.sqlite` or Hearts' instance
database. Existing local users and saves remain in their original databases;
there is no automatic import into the split stack. Only this isolated stack's
migrations run during local startup. Ctrl+C stops the processes it launched.

`npm run dev:combined` retains the previous hub/combined-API runner for explicit
compatibility work. Cards' `dev:hub` and `dev:accounts` are also legacy helpers.
The game repositories' `dev:web` commands retain frontend-only previews with
separately configured backend destinations. Stop any preview using the same ports
before starting the full stack. See [component releases](docs/component-releases.md).

## Accounts and recovery

All three local sites share the account service and cookie session. Open
**http://localhost:3000/__dev/mail/** for file-only verification/recovery mail.
Links and local keys stay ignored by Git. The split runner does not send provider
mail or read production credentials. Production accounts and game data stay in
the existing PostgreSQL database; local setup does not migrate live data.

## Build and checks

```powershell
npm run build
npm run preview
npm run test:release
npm run test:split
```

The disposable split rehearsal covers shared login, both frontend proxies,
game recovery, account deletion and independent service restarts. It checks
that the pre-existing developer databases are unchanged. Native Nginx routing
also runs when `NGINX_BIN` is configured. `test:images`, `test:postgres`,
`test:production-restore` and `test:cutover` are explicit container rehearsals;
their setup and isolation rules are documented in `docs/`.

## Releases and production

Accounts uses `accounts-vMAJOR.MINOR.PATCH`, the gateway uses `gateway-v*`, and
the game repositories use `game-v*` and frontend-only `web-v*`. These publish
independent immutable candidates with source/digest records. They do not deploy.

The retained legacy `release.yml` is manual-only: select an existing `v*` tag and
explicitly acknowledge legacy publishing. It refuses existing image versions
and does not update `latest`. See [legacy publishing](docs/legacy-releases.md).

Production uses the reviewed Infra `nuttybox` split configuration with immutable
pins, separate runtime database roles, and a guarded combined rollback target.
Cards containers do not opt into moving-tag auto-updates. These review changes
do not change Infra, publish images, retire rollback artifacts, or deploy code.
The [production cutover receipt](release/deployments/split-2026-10-22/README.md)
records the original ownership handoff. Current operator procedures live in
the sibling Infra repository's `docs/cards-split-default.md` and
`docs/cards-operations.md`.

## Assets

Logos and fonts are reused from Hearts and Euchre. License notices are in
`public/assets/`. The navbar uses the games' licensed Font Awesome icons as
bundled SVGs. No package-install token is needed for the hub.
