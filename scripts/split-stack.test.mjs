import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { apiDestination } from './api-destination.mjs';
import {
  freePort,
  isolatedEnvironment,
  root,
  stackSettings,
  startNativeStack,
} from './split-stack.mjs';
import { verifySplitStack } from './verify-split-stack.mjs';

test('split routes preserve aliases and queries while explicit combined routing remains supported', () => {
  const accounts = new URL('http://accounts.invalid:5001');
  const split = {
    accounts,
    hearts: new URL('http://hearts.invalid:5001'),
    euchre: new URL('http://euchre.invalid:5002'),
    legacy: null,
  };
  for (const [path, host, destination] of [
    ['/api/account/session', 'accounts.invalid:5001', '/account/session'],
    ['/api/hearts/games/active', 'hearts.invalid:5001', '/games/active'],
    ['/api/stats', 'hearts.invalid:5001', '/stats'],
    ['/api/euchre/leaderboard', 'euchre.invalid:5002', '/account/euchre/leaderboard'],
    ['/api/account/euchre/results', 'euchre.invalid:5002', '/account/euchre/results'],
    ['/hearts/socket.io', 'hearts.invalid:5001', '/socket.io/'],
    ['/euchre/socket.io/', 'euchre.invalid:5002', '/socket.io/'],
  ]) {
    const incoming = new URL(path + '?next=%2Fgame&value=one%20two', 'http://localhost');
    const selected = apiDestination(incoming, split);
    assert.equal(selected.host, host);
    assert.equal(selected.pathname, destination);
    assert.equal(selected.search, incoming.search);
    assert.equal(apiDestination(incoming, { accounts }).host, accounts.host);
  }
  assert(apiDestination(new URL('http://localhost/socket.io/'), split).retired);
});

test('Golf keeps its own API prefix and socket path and never falls back to another game', () => {
  const accounts = new URL('http://accounts.invalid:5001');
  const golf = new URL('http://golf.invalid:5003');
  for (const path of ['/api/golf/stats', '/api/golf/rooms/ABC123', '/golf/socket.io/', '/golf/socket.io']) {
    const incoming = new URL(path + '?EIO=4&transport=polling', 'http://localhost');
    const selected = apiDestination(incoming, { accounts, golf });
    assert.equal(selected.host, golf.host);
    assert.equal(selected.pathname, path);
    assert.equal(selected.search, incoming.search);
    assert(apiDestination(incoming, { accounts }).unavailable);
  }
});

test('split configuration rejects inherited database and service secrets', async () => {
  const clean = isolatedEnvironment({
    PATH: 'keep',
    DATABASE_URL: 'never-open',
    JWT_SECRET: 'never-use',
    CARDS_ACCOUNTS_URL: 'never-call',
    SMTP2GO_API_KEY: 'never-send',
    PGOPTIONS: 'never-use',
  });
  assert.deepEqual(clean, { PATH: 'keep' });
  await assert.rejects(stackSettings(resolve(root, '.local/accounts')), /dedicated/);
});

test(
  'three independent native services survive component-only restarts through the gateway',
  { timeout: 120000 },
  async () => {
    await mkdir(resolve(root, '.local'), { recursive: true });
    const directory = await mkdtemp(resolve(root, '.local/split-rehearsal-'));
    const before = await Promise.all(
      ['../hearts/api/instance/hearts.db', '.local/accounts.sqlite'].map(async (path) => [
        path,
        await readFile(resolve(root, path)).catch(() => null),
      ])
    );
    let stack;
    try {
      stack = await startNativeStack({
        directory,
        web: true,
        webPorts: { hearts: await freePort(), euchre: await freePort() },
      });
      stack.checkWebRoutes = async ({ cookie, origin, solo, username }) => {
        const headers = { Cookie: cookie, Origin: origin };
        for (const role of ['hearts', 'euchre']) {
          const session = await (
            await fetch(stack.webBase(role) + '/api/account/session', { headers })
          ).json();
          assert.equal(session.user.name, username);
        }
        const game = await (
          await fetch(stack.webBase('hearts') + '/api/hearts/games/' + solo.game_id, { headers })
        ).json();
        assert.equal(game.phase, 'passing');
        assert.equal(game.human_hand.length, 13);
        assert.equal(
          (await fetch(stack.webBase('hearts') + '/api/preferences', { headers })).status,
          200
        );
        for (const path of ['/api/euchre/leaderboard', '/api/account/euchre/leaderboard'])
          assert(
            (await (await fetch(stack.webBase('euchre') + path, { headers })).json()).all_time
          );
      };
      assert((await verifySplitStack(stack)).independentRestarts);
    } catch (error) {
      error.message += '\n' + stack?.logs();
      throw error;
    } finally {
      await stack?.close();
    }
    for (const [path, bytes] of before)
      assert.deepEqual(
        await readFile(resolve(root, path)).catch(() => null),
        bytes,
        'Existing database changed: ' + path
      );
  }
);

test(
  'the Nginx rehearsal routes use separate backends and preserve game recovery',
  { timeout: 120000, skip: !process.env.NGINX_BIN },
  async () => {
    await mkdir(resolve(root, '.local'), { recursive: true });
    const directory = await mkdtemp(resolve(root, '.local/split-nginx-'));
    let stack;
    try {
      stack = await startNativeStack({ directory, gateway: 'nginx' });
      assert((await verifySplitStack(stack)).independentRestarts);
    } catch (error) {
      error.message += '\n' + stack?.logs();
      throw error;
    } finally {
      await stack?.close();
    }
  }
);
