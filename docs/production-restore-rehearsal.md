# Rehearse split services against production data

This opt-in command reads the production Hearts schema and tests the reviewed split images against a disposable local restore. It does not activate the split services, modify Infra, publish images, pause the updater, or write to the production database.

From Cards, with Docker running, Node dependencies installed, and approved SSH access through the existing host aliases:

```powershell
npm run test:production-restore -- --pins release/rehearsals/split-v1.0.0/pins.json --ssh-config .local/infra-ssh-config --ssh-host cards-box
```

The SSH configuration must use trusted host keys and noninteractive authentication. Use a path without spaces relative to Cards: Windows OpenSSH's ProxyJump child mishandles an absolute configuration path containing spaces. No keys or configuration contents are copied into images or reports.

The source command is fixed to a read-only `pg_dump` of `shmemcity`'s `hearts` schema, using PostgreSQL's `default_transaction_read_only=on`. The custom-format archive streams directly over SSH into `pg_restore`; the runner never saves the dump to a host or local archive file. Restoration strips production ownership and ACLs. PostgreSQL has a unique private Compose network, no published database port, and RAM-backed storage. Only a randomly selected loopback gateway port is exposed.

The runner accepts exact published image digests and performs no builds. All database actions after the dump use its newly created `split_rehearsal` database and `hearts` schema. The audit helper refuses other database names, hosts, schemas, or users. Migration and runtime credentials are local rehearsal credentials. Signing/service keys are newly generated, mail is file-only, and production signing/mail secrets are never read.

Before starting workers, the runner retains a private reference copy of every original table inside the disposable database. It requires legacy revision `019`, refuses legacy Hearts multiplayer snapshots without durable account links, runs each independent migration twice, and compares every original column and sequence. Original account IDs, password hashes, opaque session records, recovery data, preferences, achievements, history, and saves are included in that comparison. Supplemental service-owned tables are additive. The normal ordered migration jobs then run again during startup.

The restricted runtime roles must pass all table/sequence privilege checks. After cold startup, original fingerprints must still match. A rehearsal-only opaque session then checks an existing restored account's identity, profile, preferences, Hearts scores, and Euchre history through the gateway; no real user's password or live session is used. Every restored Hearts solo save is opened through the published Hearts HTTP API. A generated account separately exercises shared login, polling/WebSocket upgrade, game persistence, component-only replacement, guest continuity, and coordinated deletion.

After those functional checks, the runner compares every original row by its original primary key. Two expected housekeeping operations are explicit: the Euchre `create` command deletes snapshots older than its 20-minute idle window, and creating an account session deletes expired sessions. The audit uses the time immediately before the functional probe to identify those already-expired records, counts their removal separately, and requires every unexpired original session and every other original value to match. Migration, cold-start, and restored-save checks allow neither exception. Targeted in-memory tests reject valid-session loss and credential changes. No copied active game is manually edited or drained to force readiness.

The report contains image pins, component health versions, aggregate row counts, and check results. It contains no account rows, emails, hashes, tokens, game IDs, or hand contents. Database/audit copies disappear with the rehearsal container; generated test mail is removed after shutdown. Diagnostic capture suppresses private SQL/service output on failure, and binary backup bytes never enter process logs.

Before a real cutover, repeat the backup at the maintenance boundary, check current multiplayer ownership/drain requirements, retain production account secrets and cookie origin, and apply the separately reviewed infrastructure/routing changes. This isolated run does not prove a live multiplayer handoff or authorize two production game writers.
