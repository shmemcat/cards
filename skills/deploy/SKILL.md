---
name: deploy
description: Release and deploy all current code in Hearts, Euchre, Golf, or Cards, including requests written as /deploy hearts, /deploy euchre, /deploy golf, or /deploy cards. Apply to an actual production-release request; setup, release-process discussions, and status checks do not authorize deployment.
---

# Deploy Hearts, Euchre, Golf or Cards

Accept `hearts`, `euchre`, `golf` or `cards` after `/deploy`, `$deploy`, or an equivalent
release request. Use the named repository's current code, including intended
uncommitted files and committed changes not yet in production. An invocation is
authorization to test, fix release-blocking issues within scope, commit, push,
publish and deploy that repository. Finish the authorized release without asking
for another routine confirmation. Respect an explicit prepare-only or hold.

Read [operations](references/operations.md) for repository locations, component
selection, checks, release artifacts, SSH and the host promotion protocol.

## Prepare the complete source

- Inspect the named repository's branch, tracked diff, staged files, untracked
  source, remote main and deployed component revisions. Preserve work in the
  other repositories. Include all intended current project code; exclude ignored
  build output, local databases, credentials and private rehearsal files.
- Compare each relevant component's deployed source with the final source, not
  just the working-tree diff. Previously committed but unreleased changes count.
  Include shared build inputs and dependencies when selecting components.
- Run the appropriate source checks and relevant integration tests. Use existing
  isolated test runners. Never point tests at a persistent development database
  or production database, and never inherit live database/service credentials.
- Write a short factual commit subject followed by a blank line and a bullet
  list describing all substantive changes being committed. Use the user's Git
  identity and configured signing key. Never include a co-author trailer, AI
  attribution, or any mention of AI in commits, tag annotations or release notes.
- Commit current changes, integrate remote `main` without discarding work, and
  push directly to the user's app repository's `main`. Preserve existing commit
  authorship and history; do not force-push main or create an app PR. If there
  are no new changes to commit, release the existing source without an empty
  commit. Put the complete unreleased-change bullets in the release summary.

## Publish and rehearse

- Choose the next unused semantic component versions from existing tags and
  published versions. Tag the tested source and push only the required component
  tags. Ordinary releases never use the combined legacy `v*` publishing path.
- Wait for the component publishing workflows to pass. Retrieve each workflow's
  release JSON artifact and verify its component, tag and source revision against
  the source being released. Use its immutable registry digest; never invent a
  digest, overwrite a versioned image, or promote `latest`.
- Rehearse the candidate images with the unchanged peer pins. For backend or
  gateway changes, use Cards' pinned-image integration runner. Run frontend
  checks for frontend changes. Keep test data and mail isolated.

## Promote and verify

- Confirm the reviewed one-time host release capability is installed and enabled
  using `sudo -n cards-release status`. If it is unavailable, finish publication
  and report the missing one-time activation; do not bypass review by switching
  Infra or patching live container units.
- Read a fresh release status immediately before preparing the request. Build
  the repository-scoped request with `scripts/prepare-request.mjs` and the actual
  published records. Send it to `sudo -n cards-release plan`, then `promote`, over
  the existing authenticated SSH connection. Preserve the optimistic generation
  check. An intervening release requires a fresh status and renewed rehearsal
  against any changed peers; never retry blindly with a new generation.
- Ordinary application promotions use the host release journal and require no
  Infra commit, Infra PR or NixOS switch. Real infrastructure/policy changes still
  require a signed Infra PR and its review. Keep the guarded combined-server
  rollback target and retained credentials unchanged.
- The host backs up before backend changes, retains previous digests, restarts
  only affected units, checks exact running release metadata and peer continuity,
  and restores previous pins if verification fails. Schema or account-contract
  changes require the explicit maintenance/migration procedure before promotion;
  never silently run migrations with runtime credentials or restore a database
  over newer writes.
- On a failed promotion, inspect status and its durable transaction. Verify an
  automatic rollback; use `cards-release recover` for an interrupted transaction.
  Stop if recovery fails and report the retained release ID. Do not loop through
  repeated deployments, escalate privileges through another identity, or bypass
  failing checks.
- Verify all enabled backends, affected public pages and game transports, and the
  unchanged peers' container IDs/start times. Use existing sessions only when
  authorized; avoid mail or real-game mutations during smoke checks. Preserve
  the release receipt and previous component pins.

Report the change bullets, commit and released versions, deployment result,
health checks and rollback release ID. State any incomplete step clearly.
