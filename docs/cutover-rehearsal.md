# Final split-service cutover and rollback rehearsal

Run the explicit runner with the reviewed Infra activation manifest:

```powershell
npm run test:cutover -- --activation ../infra/nuttybox/containers/cards-split/activation-images.json --ssh-config .local/infra-ssh-config --ssh-host cards-box
```

The runner streams the existing read-only production dump command directly into a
new local PostgreSQL database in tmpfs. It never writes a dump file, uses production
signing/mail credentials, or invokes infrastructure activation. The private database
is named `shmemcity` to exercise the exact Infra grants and rollback SQL. Its only
hostname is `db` inside a unique Compose project; no database/API ports are exposed.
The gateway binds a random loopback port. All mail uses a disposable file outbox.

The manifest pins the published Accounts, Hearts, Euchre, gateway and both frontend
images. It also pins the currently deployed combined API for rollback. Rollback
retains the candidate gateway and clients with combined-compatible routing, so open
clients retain the new transport paths. Returning to an older gateway protocol is
outside this rehearsal.

The rehearsal checks:

- Original-column fingerprints and original sequence positions through migration.
- Actual Infra runtime grants and cross-service access denial.
- Existing identity, profile, preferences, scores, Euchre history, and every restored
  Hearts solo save, first on split services and again after pre-admission rollback.
- Split-created accounts, preferences, saved solo games and game history after
  returning to the pinned combined API.
- Rollback rejection during active Hearts/Euchre multiplayer and during an account
  deletion whose Euchre callback is temporarily unavailable. The callback resumes,
  cleanup finishes, and the rehearsal verifies revocation before rollback.
- Normal player actions drain the synthetic matches before handoff. No production
  match is conceded or modified, and no active multiplayer snapshot is handed to
  a legacy owner. SQL enforces that boundary.
- Account IDs increase across split registration, deletion, legacy registration,
  and split reactivation. PostgreSQL's existing sequence is retained.
- Reconnection, polling/WebSocket upgrade, private-route blocking and independent
  component replacement after split reactivation.
- Original restored records remain intact, with expired lobby/session cleanup
  accounted for explicitly.

Writers and gateway admission stop before every ownership switch. The runner
verifies that the old owner is stopped before starting the next. Cleanup removes
the Compose project, tmpfs database and mail files on success or failure. Reports
contain only aggregates and release metadata; snapshots and credentials stay in
the disposable environment.

This exercises published application images in Docker Compose. The exact NixOS
activation/rollback targets are evaluated and built separately without `switch`.
An approved live quiet boundary and a fresh verified maintenance backup remain
required before any production activation.
