# Cards accounts API

Independent account owner extracted from Hearts. It retains existing users,
password hashes, opaque cookie sessions, profile/verification/recovery behavior,
and legacy Hearts authentication. No game package is imported.

Production and default local development use this account owner with separate
Hearts and Euchre servers. The account runtime requires its own reviewed
migration job and private game peers.
See `../docs/accounts-service.md` for configuration, migration, deletion,
verification, and staged activation details.

Run tests with `uv run --locked --extra dev pytest tests -q`.

`accounts-vMAJOR.MINOR.PATCH` releases publish only the accounts image and a digest/source/schema record, without promoting `latest`. The split stack is the local default and pinned-image CI rehearses candidate releases without deployment; see [component releases](../docs/component-releases.md).
Apply account-owned additive migrations explicitly with
`python -m cards_accounts.schema upgrade`. Runtime startup never migrates data.
