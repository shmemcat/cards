# First split-service image rehearsal

Verified on 2026-10-22. This is a candidate image set, not an active deployment configuration.

All four independent publishing workflows succeeded:

- [Accounts accounts-v1.0.0](https://github.com/shmemcat/cards/actions/runs/39876595902), source `0f77c360d74cb72da4b3b634ccf5ff6378c3660f`.
- [Hearts game-v1.0.0](https://github.com/shmemcat/hearts/actions/runs/39876763313), source `7a28dce5314f887d4f0bcd9f8b2fecd7e7c6905b`.
- [Euchre game-v1.0.0](https://github.com/shmemcat/euchre/actions/runs/39876603900), source `66843540219f89811b843fef28154229078fc7e6`.
- [Gateway gateway-v1.0.0](https://github.com/shmemcat/cards/actions/runs/39876595835), source `0f77c360d74cb72da4b3b634ccf5ff6378c3660f`.

[pins.json](pins.json) contains exactly the four published registry digests. [components.json](components.json) records their source versions, schema revisions, account contract, and explicit migration commands. The gateway has no migration command.

The local rehearsal used an exported copy of Cards at `0f77c360d74cb72da4b3b634ccf5ff6378c3660f`, with no sibling game checkouts. It installed only Cards' Node dependencies and ran the pinned mode, without source builds. The images were pulled from GHCR into a new private Compose project with disposable PostgreSQL 18 data and separate runtime roles. Service health versions/revisions matched their image labels and the release records; the gateway's source/version labels also matched.

[report.json](report.json) is the unmodified successful runner output. It confirms shared sign-in, polling-to-WebSocket upgrade, private-route blocking, independent replacement of Hearts/Euchre/accounts/gateway, persisted game recovery, continuity of the other game's state and connection, and account deletion through both game callbacks.

To repeat from Cards:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run test:images -- --pins release/rehearsals/split-v1.0.0/pins.json
```

Cleanup removed the rehearsal containers, network, and disposable database. Pre-existing local containers retained their identities and images, and both developer SQLite fingerprints remained unchanged. [deployment-images-unchanged.json](deployment-images-unchanged.json) records the five existing `latest` digests, verified equal before and after publishing. The release tags did not promote those moving tags, modify Infra, or activate the split services.

This local run is separate from dispatching the manual pinned-image CI workflow. Production-backup restoration, live-game drain and ownership checks, and the reviewed routing/pin cutover remain future work. See [component releases](../../../docs/component-releases.md).
