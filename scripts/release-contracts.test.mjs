import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';
import { validatePins, repositories } from './container-stack.mjs';
import { replacePin } from './component-pins.mjs';

const root = resolve(import.meta.dirname, '..');
const yaml = async (path) => parse(await readFile(resolve(root, path), 'utf8'));
const fakePins = Object.fromEntries(
  Object.entries(repositories).map(([role, image]) => [
    role,
    `ghcr.io/shmemcat/${image}@sha256:${'a'.repeat(64)}`,
  ])
);

test('candidate promotion and rollback change only the selected digest', () => {
  validatePins(fakePins);
  const next = replacePin(
    fakePins,
    'hearts',
    `ghcr.io/shmemcat/hearts-game-api@sha256:${'b'.repeat(64)}`
  );
  assert.equal(next.accounts, fakePins.accounts);
  assert.equal(next.euchre, fakePins.euchre);
  assert.equal(next.gateway, fakePins.gateway);
  assert.notEqual(next.hearts, fakePins.hearts);
  assert.deepEqual(replacePin(next, 'hearts', fakePins.hearts), fakePins);
  for (const image of [
    'latest',
    'ghcr.io/shmemcat/hearts-game-api:game-v1.0.0',
    'ghcr.io/shmemcat/euchre-game-api@sha256:' + 'a'.repeat(64),
  ])
    assert.throws(() => replacePin(fakePins, 'hearts', image));
  assert.throws(() => validatePins({ ...fakePins, extra: 'ignored' }));
});

test('the container stack has serial migrations, separate roles, and no external data or public private-service ports', async () => {
  const config = await yaml('deploy/compose.split.yml');
  assert.equal(
    config.services['hearts-migrate'].depends_on['accounts-migrate'].condition,
    'service_completed_successfully'
  );
  assert.equal(
    config.services['euchre-migrate'].depends_on['hearts-migrate'].condition,
    'service_completed_successfully'
  );
  assert.equal(
    config.services.grants.depends_on['euchre-migrate'].condition,
    'service_completed_successfully'
  );
  const databases = [];
  for (const role of ['accounts', 'hearts', 'euchre']) {
    const service = config.services[role];
    assert(service.environment.DATABASE_URL.includes(role + '_runtime:'));
    assert(!service.environment.DATABASE_URL.includes('migrator:'));
    assert(!service.ports && !service.build && !service.env_file);
    assert(!service.environment.JWT_SECRET || role === 'accounts');
    databases.push(service.environment.DATABASE_URL);
    assert.equal(service.depends_on.grants.condition, 'service_completed_successfully');
  }
  assert.equal(new Set(databases).size, 3);
  assert(!config.volumes && !config.networks);
  assert(config.services.db.tmpfs.length);
  assert(!config.services.db.ports);
  assert.equal(config.services.gateway.ports.length, 1);
});

test('pinned-image CI never checks out or builds another application repository', async () => {
  const workflow = await yaml('.github/workflows/split-integration.yml');
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  assert.equal(workflow.permissions.packages, 'read');
  const steps = workflow.jobs.verify.steps;
  assert.equal(steps.filter((step) => step.uses?.startsWith('actions/checkout@')).length, 1);
  assert(
    !steps.some(
      (step) => step.with?.repository || step.uses?.startsWith('docker/build-push-action')
    )
  );
  assert(steps.some((step) => step.run === 'npm run test:images'));
});

test('gateway releases publish an immutable candidate without deploying or migrating', async () => {
  const workflow = await yaml('.github/workflows/gateway-release.yml');
  assert.deepEqual(workflow.on.push.tags, ['gateway-v*']);
  assert(!JSON.stringify(workflow).includes(':latest'));
  const steps = workflow.jobs.release.steps;
  const build = steps.find((step) => step.uses?.startsWith('docker/build-push-action'));
  assert.equal(build.with.context, '.');
  assert.equal(build.with.file, 'deploy/Dockerfile');
  assert(build.with.tags.startsWith('ghcr.io/shmemcat/cards-web:'));
  assert(steps.some((step) => step.run?.includes('--gateway check')));
  assert(steps.some((step) => step.run?.includes('--gateway record')));
  const config = JSON.parse(await readFile(resolve(root, 'release/gateway.json'), 'utf8'));
  const { releaseRecord, validateTag } = await import('./component-release.mjs');
  const record = releaseRecord(config, 'gateway-v1.0.0', 'a'.repeat(40), 'sha256:' + 'b'.repeat(64));
  assert.equal(record.schemaRevision, null);
  assert.deepEqual(record.migrationCommand, []);
  assert.throws(() => validateTag(config, 'v1.0.0'));
});

test('component workflows publish only their own immutable artifact and preserve legacy v-tag releases', async () => {
  for (const [repo, path, context, prefix, image] of [
    ['cards', '.github/workflows/accounts-release.yml', 'api', 'accounts-v', 'cards-accounts-api'],
    [
      'hearts',
      '../hearts/.github/workflows/game-release.yml',
      'game-api',
      'game-v',
      'hearts-game-api',
    ],
    ['euchre', '../euchre/.github/workflows/game-release.yml', 'api', 'game-v', 'euchre-game-api'],
  ]) {
    // Cards checks run from its own checkout; each game also runs the copied component contract tests independently.
    if (!existsSync(resolve(root, path))) continue;
    const workflow = await yaml(path);
    assert.deepEqual(workflow.on.push.tags, [prefix + '*']);
    const steps = workflow.jobs.release.steps;
    const builds = steps.filter((step) => step.uses?.startsWith('docker/build-push-action'));
    assert.equal(builds.length, 1);
    assert.equal(builds[0].with.context, context);
    assert(builds[0].with.tags.startsWith('ghcr.io/shmemcat/' + image + ':'));
    assert(!JSON.stringify(workflow).includes(':latest'));
    assert(steps.some((step) => step.run?.includes('component-release.mjs check')));
    assert(steps.some((step) => step.run?.includes('component-release.mjs record')));
    assert(steps.some((step) => step.run?.includes('{{json .Manifest}}')));
    const legacy = await yaml(
      repo === 'cards'
        ? '.github/workflows/release.yml'
        : `../${repo}/.github/workflows/release.yml`
    );
    assert.deepEqual(legacy.on.push.tags, ['v*']);
    assert(JSON.stringify(legacy).includes(':latest'));
  }
});
