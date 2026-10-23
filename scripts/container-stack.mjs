import { mkdir, mkdtemp, readFile, readdir, chmod } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { startProcess, waitForService } from './service-process.mjs';
import { freePort, isolatedEnvironment, root } from './split-stack.mjs';
import { streamProductionRestore } from './production-backup.mjs';

export const repositories = {
  accounts: 'cards-accounts-api',
  hearts: 'hearts-game-api',
  euchre: 'euchre-game-api',
  gateway: 'cards-web',
};
export function validatePins(pins) {
  if (
    !pins ||
    Array.isArray(pins) ||
    Object.keys(pins).sort().join(',') !== Object.keys(repositories).sort().join(',')
  )
    throw new Error('Pin exactly accounts, hearts, euchre, and gateway.');
  for (const [role, repository] of Object.entries(repositories)) {
    if (
      !new RegExp('^ghcr\\.io/shmemcat/' + repository + '@sha256:[a-f0-9]{64}$').test(
        pins[role] || ''
      )
    )
      throw new Error(`${role} requires its exact ghcr.io/shmemcat/${repository}@sha256 digest.`);
  }
  return pins;
}

export async function startContainerStack({
  pins,
  build = false,
  configOnly = false,
  echo = false,
  signal,
  onCreated,
  databaseSchema = 'public',
  prepareDatabase,
  privateData = false,
} = {}) {
  if (!['public', 'hearts'].includes(databaseSchema)) throw new Error('Unsupported rehearsal schema');
  if (!build) validatePins(pins || {});
  await mkdir(resolve(root, '.local'), { recursive: true });
  const directory = await mkdtemp(resolve(root, '.local/split-images-'));
  const outbox = resolve(directory, 'outbox');
  await mkdir(outbox);
  await chmod(outbox, 0o777);
  const port = await freePort();
  const project = 'cards-split-' + randomBytes(5).toString('hex');
  const credential = () => randomBytes(40).toString('hex');
  const env = {
    ...isolatedEnvironment(),
    SPLIT_PROJECT: project,
    SPLIT_PORT: String(port),
    SPLIT_PUBLIC_URL: `http://localhost:${port}`,
    SPLIT_DATABASE_OPTIONS: databaseSchema === 'hearts' ? '?options=-csearch_path%3Dhearts' : '',
    SPLIT_PGOPTIONS: databaseSchema === 'hearts' ? '-csearch_path=hearts' : '',
    SPLIT_OUTBOX: outbox,
    SPLIT_JWT_SECRET: credential(),
    SPLIT_HEARTS_READ: credential(),
    SPLIT_EUCHRE_READ: credential(),
    SPLIT_HEARTS_CALLBACK: credential(),
    SPLIT_EUCHRE_CALLBACK: credential(),
    ...Object.fromEntries(
      Object.keys(repositories).map((role) => [
        role.toUpperCase() + '_IMAGE',
        build ? `${repositories[role]}:${project}` : pins[role],
      ])
    ),
  };
  const args = [
    'compose',
    '--project-name',
    project,
    '--env-file',
    resolve(root, 'deploy/split/empty.env'),
    '-f',
    resolve(root, 'deploy/compose.split.yml'),
    ...(build ? ['-f', resolve(root, 'deploy/compose.split.build.yml')] : []),
  ];
  async function command(extra, capture = false) {
    const cleanup = extra[0] === 'down';
    if (!cleanup) signal?.throwIfAborted();
    const process = startProcess('docker', [...args, ...extra], {
      cwd: root,
      env,
      label: 'isolated images',
      echo: echo && !capture,
    });
    const abort = () => void process.close();
    if (!cleanup) signal?.addEventListener('abort', abort, { once: true });
    try {
      await process.success();
      return (capture ? process.stdout() : process.logs()).trim();
    } catch (error) {
      if (privateData) {
        const audit = extra.includes('/rehearsal/restore-audit.py')
          ? process.logs().match(/Original records changed in [a-z_]+(?:; columns=[a-z_,]*; rows=[0-9,]+)?|Private audit failed: [A-Za-z]+|Expired restored credentials were not cleaned up/)
          : null;
        throw new Error(audit?.[0] || `Isolated ${extra[0]} failed; private database output withheld.`);
      }
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }
  const stack = {
    directory,
    port,
    command,
    restoreProduction: (options) => streamProductionRestore({
      ...options, args: [...args, 'exec', '-T', 'db', 'pg_restore', '--exit-on-error',
        '--no-owner', '--no-acl', '-U', 'migrator', '-d', 'split_rehearsal'],
      env, signal,
    }),
    base: (role) => {
      if (role !== 'gateway') throw new Error('Private container ports are not published');
      return `http://127.0.0.1:${port}`;
    },
    identity: (role) => command(['ps', '-q', role], true),
    async health(role) {
      const servicePort = role === 'euchre' ? 5002 : 5001;
      const health = JSON.parse(
        await command(
          [
            'exec',
            '-T',
            role,
            'python',
            '-c',
            `import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:${servicePort}/health',timeout=2).read().decode())`,
          ],
          true
        )
      );
      if (!build) {
        const image = env[role.toUpperCase() + '_IMAGE'];
        const inspect = startProcess(
          'docker',
          ['image', 'inspect', '--format', '{{json .Config.Labels}}', image],
          { cwd: root, env, label: 'release labels' }
        );
        await inspect.success();
        const labels = JSON.parse(inspect.stdout());
        assert(
          /^[a-f0-9]{40}$/.test(health.revision),
          'Published images must report their source revision'
        );
        assert.equal(health.revision, labels['org.opencontainers.image.revision']);
        assert.equal(health.version, labels['org.opencontainers.image.version']);
      }
      return health;
    },
    async restart(role) {
      if (!['accounts', 'hearts', 'euchre', 'gateway'].includes(role))
        throw new Error('Unknown component');
      await command([
        'up',
        '-d',
        '--no-deps',
        '--force-recreate',
        '--wait',
        '--wait-timeout',
        '60',
        role,
      ]);
      if (role === 'gateway')
        await waitForService(stack.base('gateway') + '/api', 'cards-accounts', null, 60000);
    },
    async mail() {
      return Promise.all(
        (await readdir(outbox))
          .filter((name) => name.endsWith('.json'))
          .sort()
          .map(async (name) => JSON.parse(await readFile(resolve(outbox, name), 'utf8')))
      );
    },
    async close() {
      await command(['down', '--volumes', '--remove-orphans']);
    },
    async checkPrivileges() {
      for (const [role, packageName, forbidden] of [
        ['hearts', 'hearts_server', 'users'],
        ['euchre', 'euchre_server', 'users'],
        ['accounts', 'cards_accounts', 'active_games'],
      ]) {
        const code = `from ${packageName}.wsgi import app\nfrom ${packageName}.extensions import db\nfrom sqlalchemy import text\nfrom sqlalchemy.exc import ProgrammingError\nwith app.app_context():\n try:\n  db.session.execute(text('SELECT * FROM ${forbidden} LIMIT 0'))\n except ProgrammingError as error:\n  assert getattr(error.orig,'pgcode',None)=='42501'\n else:\n  raise AssertionError('Runtime has access to another service')`;
        await command(['exec', '-T', role, 'python', '-c', code], true);
      }
    },
  };
  // Render without exposing generated keys in logs or touching the Docker daemon.
  await command(['config', '--quiet'], true);
  if (configOnly) return { directory, validated: true };
  onCreated?.(stack);
  try {
    if (build) await command(['build', 'accounts', 'hearts', 'euchre', 'gateway']);
    else await command(['pull']);
    if (prepareDatabase) {
      await command(['up', '-d', '--wait', '--wait-timeout', '60', 'db']);
      await prepareDatabase(stack);
    }
    await command(['up', '-d', '--wait', '--wait-timeout', '120']);
    await waitForService(stack.base('gateway') + '/api', 'cards-accounts', null, 60000);
    await stack.checkPrivileges();
    return stack;
  } catch (error) {
    const logs = privateData ? '' : await command(['logs', '--no-color', '--tail', '40']).catch(() => '');
    await stack.close().catch(() => {});
    throw new Error(error.message + '\n' + logs);
  }
}
