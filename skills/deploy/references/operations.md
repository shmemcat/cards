# Repository and release operations

The Windows workspace contains sibling repositories under
`D:/My Documents/Code`: `cards`, `hearts`, `euchre`, `golf`, and `infra`. Locate the same
siblings from the selected checkout when running elsewhere. Verify remotes:
application repositories are `github.com/shmemcat/<repo>`; Infra is
`forge.nuttynet/nuttyverse/infra`, default branch `kernel`.

## Component selection and checks

- Hearts backend: `game-api/`, `game-v*`, `hearts-game-api`, record `hearts-game`.
- Hearts frontend: `web/`, `web-v*`, `hearts-cards-web`, record `hearts-web`.
- Euchre backend: `api/`, `game-v*`, `euchre-game-api`, record `euchre-game`.
- Euchre frontend: `web/`, `web-v*`, `euchre-web`, record `euchre-web`.
- Golf backend: `api/`, `game-v*`, `golf-game-api`, record `golf-game`.
- Golf frontend: `web/`, `web-v*`, `golf-web`, record `golf-web`.
- Cards accounts: `api/`, `accounts-v*`, `cards-accounts-api`, record `cards-accounts`.
- Cards hub/gateway: web assets, `scripts/build.mjs`, `scripts/serve.mjs`,
  `deploy/Dockerfile` and relevant gateway inputs; `gateway-v*`, `cards-web`,
  record `cards-gateway`. Read the actual Dockerfile for build dependencies.

Component configurations live in `release/component.json`, `release/web.json`
or Cards' `release/gateway.json`. Publishing workflows are
`.github/workflows/{game,web,accounts,gateway}-release.yml` as applicable.
Read the selected workflows for their current checks and artifact names.
Documentation or skill-only edits need no running image unless a build consumes
them. Include relevant root manifests, lockfiles and shared build inputs when
comparing deployed component sources. Release all affected components from the
same final commit if both frontend and backend changed.

Use repository scripts and the selected publishing workflow's checks. Backend
environments use `uv sync --locked --extra dev` and
`uv run --locked --extra dev pytest -q` in the independent backend directory.
Frontend checks use each `web/package.json`, including tests, type checks and
production build as applicable. Euchre backend changes also need
`npm run test:multiplayer-rules`. Release-policy tests are `npm run test:release`.
Cards provides `npm run test:images -- --pins <candidate.json>` for pinned backend
and gateway images. That manifest has exactly accounts, hearts, euchre and
gateway image keys. Run from Cards; it never uses production/developer data.
Frontend-only changes do not require rebuilding unchanged backend images.

## Authentication and release records

Prefer installed Git/hosting tools and the user's saved credentials. Retrieve
credentials only in memory, never in logs, repository files or command arguments.
GitHub's REST API can retrieve workflow runs and artifact ZIPs using the saved
GitHub credential. Verify the run belongs to the selected component tag and
source; extract only the expected JSON entry, without trusting archive paths.
Do not use another user's credentials or service-side administrator tokens.

For Forgejo OAuth, the API uses Bearer authentication. If a Git credential has
expired, use Git Credential Manager's actual host authentication challenge and
refresh flow. A generic password check can incorrectly reject a valid OAuth
token. Preserve unrelated credentials and request interactive renewal only when
the saved refresh cannot complete. Infrastructure commits require GPG signatures
and Nutty Nux's reviewed PR process. Application commits use the user's identity
and configured signing settings.

## Host promotion

Use the existing SSH configuration. Cards currently has a private local SSH
configuration at `.local/infra-ssh-config`, alias `cards-box`, with a verified
host-key file and the user's SSH identity. Reuse it when present; otherwise read
Infra's `docs/deployment.md` and the user's configured `nuttybox` alias. Never
disable host-key checking or copy a private key into a repository.

The reviewed host command is `sudo -n cards-release`. Its status reports all enabled
exact image pins, component release metadata, a generation and pending-recovery
status. For bootstrap entries without release metadata, inspect the pinned
image's OCI source/version labels and verify them against the app repository.

1. Save fresh `cards-release status` JSON locally, with no credentials.
2. Run the skill's `scripts/prepare-request.mjs <repo> <status.json>
   <release-record.json> [second-record.json]` using Node 22. It prints the
   request JSON. Pass input/output through files or structured subprocess stdin;
   do not interpolate JSON into shell commands.
3. Send that request over SSH stdin to `sudo -n cards-release plan`, then
   `sudo -n cards-release promote`. Retain the returned `releaseId` and generation.
4. Run `sudo -n cards-release verify` and inspect status. Check affected public
   pages/assets and game transports, and all enabled backend health/readiness
   endpoints using existing read-only probes. Verify unaffected containers kept
   their IDs and start times.

The host serializes releases, refuses stale generations and unknown components,
and validates image source/version labels. Backend promotions take and validate
a fresh private logical backup; they never run startup migrations. Failure
restores only affected component pins. The journal and exact previous pins live
in root-only `/data/cards-releases/`, covered by existing encrypted `/data`
backups. Routine component rollback is `cards-release rollback <releaseId>
--expected-generation <fresh-generation>`; it preserves later releases of other
components. `cards-release recover` repairs an interrupted transaction. The
separate guarded combined-owner rollback remains an explicit maintenance action.

Read Infra's `docs/cards-releases.md` for activation, migration limits and
operational recovery. A deployment request does not authorize initial activation
of an unreviewed host capability, credential retirement, a destructive schema
change or restoration over subsequent production writes.

## Golf

Golf uses the same release journal, readiness checks and rollback as the other
games, with no moving-image updater. Use `/deploy golf` to publish and promote
its affected game/web components. Run `npm test`, `npm run build`,
`npm run test:api`, `npm run test:release`, `npm run test:online` and
`npm run test:accounts` for its initial release or relevant boundary changes.
For pinned production-image rehearsal, run Golf's `scripts/rehearse-release.mjs`
with the fresh host status and candidate records; it checks the actual published
Golf images, gateway routes, shared login, both socket transports and deletion
using disposable PostgreSQL data. Keep the existing Cards peer rehearsal too
when releasing Cards accounts or gateway changes.

Golf's image rehearsal mounts the sibling Infra checkout's production
`nuttybox/containers/cards-split/proxy.conf`. Refresh Infra's main branch before
rehearsal so it tests the file that will actually be mounted on the host.

Golf must first be present in the reviewed host policy with its tables migrated
and separately scoped account credentials installed. If `status.images.golf` or
`status.images['golf-web']` is absent, finish publication and report the pending
one-time Infra activation. Never edit live policy or switch an unreviewed PR.
