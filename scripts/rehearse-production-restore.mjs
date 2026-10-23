import { readFile, writeFile, readdir, unlink, rmdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { startContainerStack, validatePins } from './container-stack.mjs';
import { verifySplitStack } from './verify-split-stack.mjs';
import { root } from './split-stack.mjs';
import { validateRestoreArguments } from './production-backup.mjs';

validateRestoreArguments(process.argv.slice(2));
const argument = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
};
const pinsPath = argument('--pins');
if (!pinsPath) throw new Error('Provide --pins with the reviewed published image set');
const pins = validatePins(JSON.parse(await readFile(resolve(pinsPath), 'utf8')));
const sshConfig = resolve(argument('--ssh-config', resolve(root, '.local/infra-ssh-config')));
const host = argument('--ssh-host', 'cards-box');
const controller = new AbortController();
for (const name of ['SIGINT', 'SIGTERM']) process.once(name, () => controller.abort());
let stack, restored, migrations, privileges;
async function audit(value, action) {
  const result = await value.command(['run', '--rm', '-T', '--no-deps',
    '-v', `${resolve(root, 'scripts')}:/rehearsal:ro`, '-e', 'PYTHONPATH=/app',
    'accounts-migrate', 'python', '/rehearsal/restore-audit.py', action], true);
  return JSON.parse(result);
}
try {
  stack = await startContainerStack({
    pins, databaseSchema: 'hearts', privateData: true, echo: true, signal: controller.signal,
    onCreated: value => { stack = value; },
    async prepareDatabase(value) {
      console.log('Streaming a read-only production dump directly into disposable PostgreSQL.');
      await value.restoreProduction({ sshConfig, host });
      restored = await audit(value, 'capture');
      console.log(JSON.stringify({ restored: restored.tables, legacyRevision: restored.revision }));
      for (let attempt = 0; attempt < 2; attempt++)
        for (const [role, packageName] of [['accounts', 'cards_accounts'], ['hearts', 'hearts_server'], ['euchre', 'euchre_server']])
          await value.command(['run', '--rm', '-T', '--no-deps', `${role}-migrate`,
            'python', '-m', `${packageName}.schema`, 'upgrade'], true);
      migrations = await audit(value, 'verify');
      await value.command(['run', '--rm', '-T', '--no-deps', 'grants'], true);
      const result = await value.command(['run', '--rm', '-T', '--no-deps',
        '-v', `${resolve(root, 'scripts')}:/rehearsal:ro`, '-e', 'PYTHONPATH=/app',
        'accounts-migrate', 'python', '/rehearsal/postgres-fixture.py', 'privileges'], true);
      privileges = JSON.parse(result);
      console.log('Repeated migrations preserved the restored records; runtime grants verified.');
    },
  });
  const coldStart = await audit(stack, 'verify');
  const existingAccount = await audit(stack, 'existing-account');
  const afterExistingRecovery = await audit(stack, 'verify');
  console.log('Existing-account reads and all restored solo saves passed preservation checks.');
  await audit(stack, 'mark-probe');
  const checks = await verifySplitStack(stack);
  const originalRecords = await audit(stack, 'verify-originals');
  const health = Object.fromEntries(await Promise.all(
    ['accounts', 'hearts', 'euchre'].map(async role => [role, await stack.health(role)])
  ));
  const report = { version: 1, pins, builtLocally: false, source: {
    readOnlyProductionDump: true, database: 'shmemcity', schema: 'hearts', legacyRevision: restored.revision,
    dumpStoredOnDisk: false, productionSigningAndMailSecretsCopied: false,
  }, restoredTables: restored.tables, legacyMultiplayer: restored.legacyMultiplayer,
    migrations, coldStart, afterExistingRecovery, privileges, existingAccount, checks, originalRecords, health };
  await writeFile(resolve(stack.directory, 'production-restore-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('Production-restore rehearsal passed. Report: ' + resolve(stack.directory, 'production-restore-report.json'));
} finally {
  if (stack) {
    await stack.close();
    const outbox = resolve(stack.directory, 'outbox');
    assert.equal(resolve(outbox, '..'), stack.directory);
    for (const name of await readdir(outbox)) {
      assert(name.endsWith('.json') && !name.includes('/') && !name.includes('\\'));
      await unlink(resolve(outbox, name));
    }
    await rmdir(outbox);
  }
}
