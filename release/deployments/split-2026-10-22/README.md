# Production split-service cutover

Production now runs the reviewed `nuttybox-cards-split` target from Infra commit
`ad032ec5232008a6e1a1f16483a61bafc4d34d5c` (PR #44). Accounts are shared; Hearts and
Euchre have separate processes, database roles, transport paths, and image pins.

The [aggregate receipt](report.json) records the actual NixOS switch and public
HTTPS checks. It contains no account identifiers, credentials, or game state.

- No active multiplayer games were present at the handoff. All writers stopped
  before the fresh root-only backup was taken.
- The exact backup was streamed into a disposable PostgreSQL instance with no
  network or published ports. Its checksum, all 11 original tables, and sequence
  positions matched. The verification instance was removed afterward.
- The split migrations preserved all original columns and sequence positions;
  501 effective runtime permission checks passed. All 31 original solo saves loaded.
- Accounts, Hearts, and Euchre passed live readiness, shared login, sockets,
  independent restart, recovery, sign-out revocation, and deletion-callback checks.
  Only a disposable verified test account was provisioned; no external email was
  sent. The test account and pending cleanup were removed before reopening.
- Six public HTML routes, 16 asset references, both polling-to-WebSocket upgrades,
  secure shared cookies, internal-route isolation, and three legacy redirects passed.
- All six Cards containers use the reviewed digests without auto-update labels.
  The old combined writer and standalone web container are stopped. The updater
  was restored for unrelated services, and temporary credentials and maintenance
  conditions were removed.

The combined `nuttybox` output remains available for historical configuration;
future deployments must explicitly select `nuttybox-cards-split`. Use the reviewed
guarded rollback target and a new quiet boundary for any reverse handoff. Never
restore this backup over subsequent live writes.

Two operator adjustments surfaced on the live host: explicitly selecting the
published images' `psycopg2` adapter for the temporary migration connection, and
using maintenance conditions because NixOS-generated `/etc` units outrank ordinary
runtime masks. The reviewed activation source itself was unchanged. The private
probe gateway also received a new address on restart; refreshing its test tunnel
completed the checks. Production uses the gateway's fixed published port.
