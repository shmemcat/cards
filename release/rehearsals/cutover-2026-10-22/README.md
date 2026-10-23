# Final cutover and guarded rollback rehearsal — 2026-10-22

Passed with a fresh read-only production dump, published immutable service and
frontend pins, exact Infra grants/routes/rollback SQL, and file-only mail. Production
services, live tags, updater, roles, and both developer databases remain unchanged.

The [report](report.json) records 501 effective permissions, preservation of all 11
original tables, and recovery of all 31 existing Hearts solo saves on both split
and combined owners. It also verifies split-created accounts, saved games,
preferences/results, pending-deletion refusal and retry completion, active-game
refusal, quiet-boundary rollback, monotonic IDs and split reactivation. Independent
component replacement and actual published frontend assets/transports pass.

Both [frontend release jobs](frontends.json) succeeded and their image labels match
the recorded source revisions. No live release tag was promoted.

Application handoffs run in Docker Compose against private PostgreSQL tmpfs. Exact
NixOS activation/rollback systems are built separately without switch. This does
not claim active multiplayer handoff or a switched NixOS VM test. Actual activation
still needs review, an explicitly approved quiet window, and a new verified backup.
See [the repeatable runner](../../../docs/cutover-rehearsal.md).

All containers/database data and rehearsal mail files were removed afterward.
Reports contain aggregate results and release metadata only.
