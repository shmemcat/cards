# Independent releases and isolated local integration

This phase adds opt-in backend releases and rehearsals. Immutable candidate images are published separately from deployment activation. The existing `v*` workflows and Infra remain unchanged; the combined `hearts-api:latest` artifact keeps its current meaning. `npm run dev` still uses the existing combined local API.

## Release one backend

In Cards, an `accounts-vMAJOR.MINOR.PATCH` tag runs `accounts-release.yml` and publishes only `ghcr.io/shmemcat/cards-accounts-api`. In Hearts and Euchre, a `game-vMAJOR.MINOR.PATCH` tag runs each repository's `game-release.yml`, publishing only `hearts-game-api` or `euchre-game-api`. Manual dispatch accepts an existing component tag. Game releases do not require the other repositories, frontend packages, account signing secrets, or the font package token.

Each workflow checks the service independently, builds and smoke-tests its image, refuses an already-published version tag, and publishes that version without promoting `latest`. The uploaded component JSON records the exact registry digest, source revision, account contract v1, owned schema revision, and explicit migration command. The source and version are also image labels and health metadata. Use the digest from this record when rehearsing or preparing an Infra pin.

The registry digest is read from Docker's [JSON manifest output](https://docs.docker.com/reference/cli/docker/buildx/imagetools/inspect/), then validated before the release record is written.

Existing `v*` workflows remain the transition releases: Cards publishes its gateway, Hearts publishes the combined API and its web variants, and Euchre publishes its web app. Switching these defaults or retiring the combined release is a later reviewed cutover. Do not use `v*` as a shortcut for a new independent backend release.

Cards also has a separate `gateway-vMAJOR.MINOR.PATCH` release for an immutable `cards-web` candidate. It publishes a gateway digest/source record without promoting `latest` or changing deployment pins. Use this when the split rehearsal needs newer proxy support while the live gateway must stay on its current release. It does not run a database migration.

## Native local stack

Install Cards' test dependencies with `npm ci --ignore-scripts`. Install the three Python environments with `uv sync --locked --extra dev` in `cards/api`, `hearts/game-api`, and `euchre/api`. The two web environments need their normal dependencies for interactive development.

Run `npm run dev:split` from Cards. It starts the hub on port 3000, Hearts and Euchre web servers on 3001 and 3002, and accounts/Hearts/Euchre backends on 5100/5101/5102. Occupied ports are rejected; the runner never adopts an existing service. Stop it with Ctrl+C.

The new stack keeps its database, stable local signing/service keys, and file-only mail in `cards/.local/split-dev/`. It never adopts `.local/accounts.sqlite`, Hearts' instance database, or inherited database credentials. Its startup runs the three explicit service migrations in order. These migrations belong to this isolated data directory; the separate service images perform no startup migrations. Tests use newly created `split-rehearsal-*` directories instead of the persistent split development directory. Private account interfaces stay off the gateway. The shared old `/socket.io` transport returns a reload response in this opt-in stack; each game uses its canonical transport path.

Open `http://localhost:3000/`. Verification and recovery mail is available at `http://localhost:3000/__dev/mail/`. The game web proxies send account calls to accounts and game calls to their respective servers. Stopping this runner only stops processes it launched.

## Container rehearsal

`npm run test:images -- --build` builds local accounts, Hearts, Euchre, and gateway images and runs an isolated PostgreSQL rehearsal. It requires Docker, sibling backend checkouts, and the local Node dependencies. It does not build game frontends or require their font token. This is a backend/gateway rehearsal; use the native runner for the full interactive web applications.

`deploy/compose.split.yml` has no persistent database volume or published database/private-service port. It runs a fresh RAM-backed PostgreSQL database, serialized accounts/Hearts/Euchre migration jobs, and a grant job before workers start. Each worker uses a separate role with access to its own tables and sequences. Runtime probes assert that games cannot select account records and accounts cannot select Hearts data. The gateway uses the opt-in `deploy/split/proxy.conf`; the normal deployment config is not replaced.

The runner chooses a unique project name, fresh service keys, a new outbox under `.local/split-images-*`, and an available loopback gateway port. It does not read the developer `.env`. Cleanup removes only this rehearsal project's containers, network, and disposable volumes. A small `report.json` remains in that rehearsal directory; it contains image references, health versions/revisions, and check results, with no account credentials or mail links.

To rehearse published images, create a JSON object with exactly `accounts`, `hearts`, `euchre`, and `gateway` keys. Each value must be its component's `ghcr.io/shmemcat/<image>@sha256:<64 lowercase hex characters>` reference. Tags, `latest`, wrong-component images, and missing pins are rejected. No published digests are invented or supplied by default.

Run `npm run test:images -- --pins path/to/pins.json`. This mode pulls pinned images and never loads the source-build overlay or checks out sibling code. The Cards **Rehearse pinned split services** workflow accepts the same four digest references and runs this check using only the Cards checkout. Grant that workflow read access to the game packages if GHCR package visibility requires it.

The common probe registers and verifies a fresh local account, signs in once, checks shared Hearts preferences and both games' routes, exercises polling-to-WebSocket upgrade, restores saved games after each game's replacement, and confirms that the other game's process, connection, hand, turn, and score stay unchanged. It separately replaces accounts and the gateway, checks session continuity, and deletes the account through both cleanup callbacks. The existing full-match rehearsal remains available as `npm run test:hearts-server`.

Use `npm run test:images -- --build --config-only` to render/validate Compose without starting containers. Passing this check is not evidence of a container build or PostgreSQL execution.

Run `npm run test:postgres` for the source-built container checks plus a synthetic legacy backup/restore rehearsal. It applies the unchanged legacy migrations through `019` to a new database in the same disposable PostgreSQL container, seeds accounts/sessions/recovery records and both games' records, and restores a PostgreSQL dump into another new database. Both databases use a `hearts` schema to exercise the deployment's search-path shape. It then runs all three independent migrations twice, compares every seeded legacy table's record fingerprints, applies the runtime grants, and checks readiness using each restricted runtime role. Permission checks cover every table and owned sequence in both the fresh and restored schemas, including denied cross-service access and denied schema creation. The legacy source checkout is needed only for this opt-in rehearsal; published-image integration still needs no sibling checkout.

The backup contains generated test data only. This command never reads a developer or production database, and is separate from the required production-backup restoration before cutover. The report includes the synthetic record fingerprints and permission-check counts. PostgreSQL dumps stay inside the disposable container and disappear during cleanup.

## Promotion and rollback pins

To prepare a candidate manifest that changes one component, run `node scripts/component-pins.mjs old-pins.json hearts IMAGE@sha256:DIGEST candidate-pins.json` with the full Hearts reference from its release record. The utility validates all four image identities, preserves the other three pins, and writes a new file instead of overwriting the previous one. Use the same command with the previous digest to prepare a rollback candidate.

Rehearse the candidate manifest before requesting the separately reviewed Infra pin/routing change. Nothing in these workflows or utilities changes production pins, promotes moving tags, applies production migrations, or deploys containers. A safe code rollback retains additive schemas, account revocation/deletion receipts, and exactly one writer for each game.

## Verification status

Verified locally on 2026-10-22: all four images build and run together on PostgreSQL 18; ordered migrations and restricted runtime roles work; shared login, polling/WebSocket upgrade, game recovery, account deletion, and individual replacement of Hearts, Euchre, accounts, and the gateway pass. The synthetic legacy `019` PostgreSQL backup restores into a separate database's `hearts` schema with matching fingerprints across all eleven seeded legacy tables (including the revision table). Running the independent migrations twice preserves those fingerprints; restricted runtime schema checks pass after grants. Reports remain under `.local/split-images-*/report.json`.

Local Node, both frontend proxies, and native Nginx rehearsals also pass with separate services and disposable SQLite data. Existing local database fingerprints remain unchanged. Workflow/pin contracts and Compose rendering pass.

The first immutable releases also passed on 2026-10-22: accounts `accounts-v1.0.0`, both games `game-v1.0.0`, and gateway `gateway-v1.0.0`. Their published digests passed a local pinned-image rehearsal from a Cards-only source export, with no sibling code or source builds. [The committed candidate records](../release/rehearsals/split-v1.0.0/README.md) include exact pins, source/schema metadata, publishing workflow links, and the successful report. The manual pinned-image CI workflow remains available for repeating this check; this local rehearsal did not dispatch it.

All five existing deployment image digests, pre-existing local containers, developer database fingerprints, release defaults, and production pins remained unchanged. Restoring a verified production backup, checking its actual deployed revision/data, and applying the reviewed cutover remain separate requirements; synthetic fixtures do not substitute for those checks.
