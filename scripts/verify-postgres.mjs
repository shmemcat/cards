import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { root } from './split-stack.mjs';

// Every connection and backup stays in this runner's newly created Compose project.
export async function verifyPostgres(stack) {
  const database = (name, role = 'migrator', password = 'split-migration-local') =>
    `postgresql://${role}:${password}@db:5432/${name}?options=-csearch_path%3Dhearts`;
  const fixture = async (name, action, publicSchema = false) =>
    stack.command([
      'run', '--rm', '-T', '--no-deps',
      '-v', `${resolve(root, 'scripts')}:/rehearsal:ro`,
      '-v', `${resolve(root, '../hearts/api/migrations')}:/legacy:ro`,
      '-e', 'PYTHONPATH=/app',
      '-e', `DATABASE_URL=${publicSchema ? database(name).split('?')[0] : database(name)}`,
      'accounts-migrate', 'python', '/rehearsal/postgres-fixture.py', action,
    ], true);
  const sql = (name, statement) => stack.command([
    'exec', '-T', 'db', 'psql', '-U', 'migrator', '-d', name,
    '-v', 'ON_ERROR_STOP=1', '-c', statement,
  ], true);
  const freshPrivileges = JSON.parse(await fixture('split_rehearsal', 'privileges', true));
  console.log('Fresh PostgreSQL role and sequence permissions verified.');
  await sql('postgres', 'CREATE DATABASE split_legacy');
  await fixture('split_legacy', 'seed', true);
  const before = JSON.parse(await fixture('split_legacy', 'fingerprints'));
  await stack.command(['exec', '-T', 'db', 'pg_dump', '-U', 'migrator', '-d', 'split_legacy',
    '-f', '/tmp/split-legacy.sql'], true);
  await sql('postgres', 'CREATE DATABASE split_restored');
  await stack.command(['exec', '-T', 'db', 'psql', '-U', 'migrator', '-d', 'split_restored',
    '-v', 'ON_ERROR_STOP=1', '-f', '/tmp/split-legacy.sql'], true);
  assert.deepEqual(JSON.parse(await fixture('split_restored', 'fingerprints')), before,
    'Backup/restore must preserve all synthetic legacy rows');
  console.log('Synthetic legacy 019 backup restored with matching record fingerprints.');
  for (let attempt = 0; attempt < 2; attempt++)
    for (const [role, packageName] of [
      ['accounts', 'cards_accounts'], ['hearts', 'hearts_server'], ['euchre', 'euchre_server'],
    ])
      await stack.command(['run', '--rm', '-T', '--no-deps',
        '-e', `DATABASE_URL=${database('split_restored')}`,
        `${role}-migrate`, 'python', '-m', `${packageName}.schema`, 'upgrade'], true);
  assert.deepEqual(JSON.parse(await fixture('split_restored', 'fingerprints')), before,
    'Repeated service migrations must preserve legacy rows and revision 019');
  console.log('Repeated service migrations preserved all legacy records.');
  await sql('split_restored', 'REVOKE CREATE ON SCHEMA hearts FROM PUBLIC; GRANT USAGE ON SCHEMA hearts TO accounts_runtime, hearts_runtime, euchre_runtime');
  await stack.command(['run', '--rm', '-T', '--no-deps', '-e', 'PGOPTIONS=-csearch_path=hearts',
    'grants', 'psql', '-h', 'db', '-U', 'migrator', '-d', 'split_restored', '-f', '/grants.sql'], true);
  const restoredPrivileges = JSON.parse(await fixture('split_restored', 'privileges'));
  for (const [role, packageName] of [
    ['accounts', 'cards_accounts'], ['hearts', 'hearts_server'], ['euchre', 'euchre_server'],
  ])
    await stack.command(['run', '--rm', '-T', '--no-deps',
      '-e', `DATABASE_URL=${database('split_restored', `${role}_runtime`, `split-${role}-local`)}`,
      role, 'python', '-m', `${packageName}.schema`, 'check'], true);
  console.log('Restored PostgreSQL permissions and all three runtime schema checks passed.');
  return {
    syntheticLegacyRevision: '019', schema: 'hearts', backupRestore: true,
    preservedTables: Object.keys(before).length, fingerprints: before,
    repeatedMigrations: true, runtimeReadiness: true, freshPrivileges, restoredPrivileges,
  };
}
