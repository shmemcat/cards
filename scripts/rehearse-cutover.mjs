import assert from 'node:assert/strict';
import { readFile, writeFile, readdir, unlink, rmdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startContainerStack, validatePins } from './container-stack.mjs';
import { verifyCutover } from './verify-cutover.mjs';
import { verifySplitStack } from './verify-split-stack.mjs';
import { root } from './split-stack.mjs';
import { validateBackupHost } from './production-backup.mjs';

const args = process.argv.slice(2),
  allowed = new Set(['--activation', '--ssh-config', '--ssh-host']);
for (let i = 0; i < args.length; i += 2)
  assert(
    allowed.has(args[i]) && args[i + 1] && !args[i + 1].startsWith('--'),
    'Use --activation FILE and optional SSH config/host'
  );
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
assert(option('--activation'), 'Provide the reviewed activation image manifest');
const manifestPath = resolve(option('--activation'));
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const pins = validatePins(manifest.services);
const infraDirectory = resolve(manifestPath, '..');
const controller = new AbortController();
for (const name of ['SIGINT', 'SIGTERM']) process.once(name, () => controller.abort());
let stack, restored, adopted, preAdmission, baselineRecovery, privileges;
async function audit(script, action) {
  return JSON.parse(
    await stack.command(
      [
        'run',
        '--rm',
        '-T',
        '--no-deps',
        '-v',
        `${resolve(root, 'scripts')}:/rehearsal:ro`,
        '-e',
        'PYTHONPATH=/app',
        'accounts-migrate',
        'python',
        '/rehearsal/' + script,
        action,
      ],
      true
    )
  );
}
const sqlFile = (file) => {
  assert(
    [
      'grants.sql',
      'rollback-check.sql',
      'rollback-prepare.sql',
      'rollforward-prepare.sql',
    ].includes(file)
  );
  return stack.command(
    [
      'exec',
      '-T',
      '-e',
      'PGOPTIONS=-csearch_path=hearts',
      'db',
      'psql',
      '-X',
      '-U',
      'migrator',
      '-d',
      'shmemcity',
      '-v',
      'ON_ERROR_STOP=1',
      '-f',
      '/infra/' + file,
    ],
    true
  );
};
try {
  stack = await startContainerStack({
    pins,
    databaseSchema: 'hearts',
    privateData: true,
    echo: true,
    signal: controller.signal,
    cutover: {
      legacy: manifest.rollback.api,
      heartsWeb: manifest.frontends.hearts,
      euchreWeb: manifest.frontends.euchre,
      infraDirectory,
    },
    onCreated: (value) => {
      stack = value;
    },
    async prepareDatabase(value) {
      console.log('Streaming a fresh read-only production dump into isolated PostgreSQL tmpfs.');
      await value.restoreProduction({
        sshConfig: resolve(option('--ssh-config', '.local/infra-ssh-config')),
        host: validateBackupHost(option('--ssh-host', 'cards-box')),
      });
      restored = await audit('restore-audit.py', 'capture');
      for (const [role, module] of [
        ['accounts', 'cards_accounts'],
        ['hearts', 'hearts_server'],
        ['euchre', 'euchre_server'],
      ])
        await value.command(
          [
            'run',
            '--rm',
            '-T',
            '--no-deps',
            role + '-migrate',
            'python',
            '-m',
            module + '.schema',
            'upgrade',
          ],
          true
        );
      adopted = await audit('restore-audit.py', 'verify');
      await sqlFile('grants.sql');
      privileges = await audit('postgres-fixture.py', 'privileges');
      await audit('restore-audit.py', 'mark-probe');
      console.log(
        'Original-column fingerprints preserved through migration; Infra runtime grants applied to the disposable copy.'
      );
    },
  });
  await stack.topology('split');
  await stack.checkPrivileges();
  baselineRecovery = await audit('restore-audit.py', 'existing-account');
  console.log('Split topology recovered the existing account and every restored solo save.');
  await stack.command(['stop', 'gateway', 'accounts', 'hearts', 'euchre'], true);
  await sqlFile('rollback-prepare.sql');
  await stack.topology('legacy');
  preAdmission = await audit('restore-audit.py', 'existing-account');
  await stack.command(['stop', 'gateway', 'legacy'], true);
  await sqlFile('rollforward-prepare.sql');
  await stack.topology('split');
  console.log('Pre-admission rollback and reactivation recovered all existing saves.');
  const checks = await verifyCutover(stack, {
    sqlFile,
    audit: (action) => audit('cutover-audit.py', action),
  });
  const isolation = await verifySplitStack(stack);
  const originals = await audit('restore-audit.py', 'verify-originals');
  const report = {
    date: '2026-10-22',
    manifest,
    productionChanged: false,
    productionDumpReadOnly: true,
    databaseStorage: 'disposable tmpfs; no dump file',
    productionCredentialsUsedInRehearsal: false,
    restoredTables: restored.tables,
    adoption: adopted,
    privileges,
    baselineRecovery,
    preAdmissionRollback: preAdmission,
    checks,
    isolation,
    originals,
    runtime:
      'Docker Compose; published image pins and Infra routes/grants; NixOS lifecycle checked separately',
  };
  await writeFile(
    resolve(stack.directory, 'cutover-report.json'),
    JSON.stringify(report, null, 2) + '\n'
  );
  console.log(
    'Cutover and rollback rehearsal passed: ' + resolve(stack.directory, 'cutover-report.json')
  );
} finally {
  if (stack) {
    await stack.close();
    const outbox = resolve(stack.directory, 'outbox');
    assert.equal(resolve(outbox, '..'), stack.directory);
    for (const name of await readdir(outbox)) {
      assert(name.endsWith('.json') && !/[\\/]/.test(name));
      await unlink(resolve(outbox, name));
    }
    await rmdir(outbox);
  }
}
