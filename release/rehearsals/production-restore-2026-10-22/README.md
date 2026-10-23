# Published split images against a production restore

Verified locally on 2026-10-22 using the exact [split-v1.0.0 image pins](../split-v1.0.0/pins.json). This rehearsal did not activate a new production writer or change the current deployment.

A fresh, read-only dump of production `shmemcity.hearts` at legacy revision `019` streamed directly into an isolated, RAM-backed PostgreSQL 18 container. The dump was not saved to an archive file. Production signing/mail secrets were not read or copied. Runtime configuration used fresh local keys, restricted database roles, loopback-only gateway access, and file-only mail.

The restored schema contained 10 users, 3 sessions, 1 recovery token, 9 Hearts stats rows, 5 preference rows, 27 difficulty stats rows, 99 Hearts results, 31 Hearts saves, 2 Euchre results, and 1 Euchre table. There were no Hearts multiplayer snapshots requiring the legacy account-link drain.

[report.json](report.json) is the successful runner's aggregate output. Original-column fingerprints across all 11 original tables and all original sequence positions matched after repeated service migrations, cold startup, and existing-account/save reads. The existing account retained its identity, profile, preferences, Hearts scores, and Euchre history when accessed with a rehearsal-only opaque session; no real password or live session was used. All 31 restored Hearts solo saves opened through the published service.

The functional probe passed shared login, polling/WebSocket upgrade, private-route blocking, independent replacement of Hearts/Euchre/accounts/gateway, recovery, guest continuity, and coordinated deletion. All 501 table/sequence permission checks passed for the three restricted runtime roles.

Final preservation checks separately accounted for two normal housekeeping removals in the isolated copy: one already-expired Euchre lobby snapshot and one already-expired anonymous account session. All unexpired original sessions and every other original record retained their original values. No snapshot or account was manually changed to make the test pass. Four targeted in-memory tests reject valid-session loss and credential changes while validating this expiry accounting.

Cleanup removed every rehearsal container/network and its restored database/audit copy, and deleted generated test mail. Production container identities/images and updater state matched before and after the run. Existing local containers, both developer SQLite fingerprints, all five existing deployment `latest` digests, and the reviewed image pins remained unchanged. Infra and the production environment were not modified.

The reusable [restore runbook](../../../docs/production-restore-rehearsal.md) describes the command and safeguards. Live multiplayer handoff and the reviewed routing/ownership cutover remain separate work. Repeat the backup and current-state checks at that maintenance boundary; this copy is not a backup of subsequent production writes.
