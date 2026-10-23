import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { io } from 'socket.io-client';
import { verifyFrontendAssets } from './frontend-assets.mjs';

const ack = (socket, event, ...args) =>
  new Promise((done, reject) =>
    socket
      .timeout(10000)
      .emit(event, ...args, (error, value) => (error ? reject(error) : done(value)))
  );
const event = (socket, name) =>
  new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for ' + name)), 15000);
    socket.once(name, (value) => {
      clearTimeout(timer);
      done(value);
    });
  });
async function until(probe, message, timeout = 45000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await delay(200);
  }
  throw new Error(message);
}

export async function verifyCutover(stack, { sqlFile, audit }) {
  const base = stack.base('gateway'),
    origin = base.replace('127.0.0.1', 'localhost');
  const password = 'isolated-cutover-rehearsal-123';
  const sockets = [];
  function actor() {
    let cookie = '',
      csrf;
    const username = 'cutover_' + randomBytes(5).toString('hex');
    const value = {
      username,
      async request(path, data, method = data === undefined ? 'GET' : 'POST', status = 200) {
        const response = await fetch(base + '/api/' + path, {
          method,
          headers: {
            Cookie: cookie,
            Origin: origin,
            ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
            'Content-Type': 'application/json',
          },
          ...(data === undefined ? {} : { body: JSON.stringify(data) }),
        });
        cookie = response.headers.get('set-cookie')?.split(';')[0] || cookie;
        assert.equal(response.status, status, path + ' response');
        const body = await response.json();
        if (body.csrf_token) csrf = body.csrf_token;
        return body;
      },
      async register() {
        await value.request('account/session');
        await value.request(
          'account/register',
          { username, email: username + '@example.test', password },
          'POST',
          201
        );
        let mail;
        await until(
          async () =>
            (mail = (await stack.mail()).find((m) => m.to === username + '@example.test')),
          'Missing rehearsal mail'
        );
        await value.request('account/verify-email', {
          token: new URL(mail.url).searchParams.get('token'),
        });
        await value.request('account/login', { username, password });
        value.id = Number((await value.request('account/session')).user.id);
      },
      async connect(namespace, path, query = {}) {
        const socket = io(base + namespace, {
          path,
          query,
          auth: { ...query, csrf },
          forceNew: true,
          reconnection: false,
          transports: ['polling', 'websocket'],
          extraHeaders: { Cookie: cookie, Origin: origin },
          timeout: 10000,
        });
        sockets.push(socket);
        let state;
        socket.on('state', (next) => {
          state = next;
        });
        await new Promise((done, reject) => {
          socket.once('connect', done);
          socket.once('connect_error', reject);
        });
        return { socket, state: () => state };
      },
    };
    return value;
  }
  const main = actor(),
    removed = actor();
  try {
    const frontends = await verifyFrontendAssets(base);
    await main.register();
    await removed.register();
    await main.request('hearts/preferences', { card_style: 'flourish' }, 'PATCH');
    const solo = await main.request(
      'hearts/games/start',
      { difficulty: 'easy', seed: 73 },
      'POST',
      201
    );
    const soloState = await main.request('hearts/games/' + solo.game_id);
    const lobby = await main.request(
      'hearts/lobbies/create',
      { host_name: main.username, num_ai: 3 },
      'POST',
      201
    );
    const lobbySocket = await main.connect('/lobby', '/hearts/socket.io', {
      lobby_code: lobby.code,
      player_token: lobby.player_token,
    });
    const started = event(lobbySocket.socket, 'game_started');
    lobbySocket.socket.emit('start_game', { difficulty: 'easy' });
    const match = await started;
    const multi = await main.connect('/multi', '/hearts/socket.io', {
      game_id: match.game_id,
      player_token: lobby.player_token,
    });
    await until(() => multi.state(), 'Hearts multiplayer did not start');
    let euchre = await main.connect('/euchre', '/euchre/socket.io');
    const table = await ack(euchre.socket, 'command', { type: 'create' });
    assert(table.ok);
    assert((await ack(euchre.socket, 'command', { type: 'start', difficulty: 'easy' })).ok);
    await until(
      () => euchre.state()?.game?.turn === 0 && euchre.state()?.game?.phase !== 'trick_complete',
      'Euchre did not reach a human turn'
    );
    await assert.rejects(sqlFile('rollback-check.sql'), /ROLLBACK_ACTIVE_MULTIPLAYER/);
    console.log('Rollback correctly refused active multiplayer.');
    await stack.command(['stop', 'euchre'], true);
    await removed.request('account/delete', { password }, 'POST', 202);
    await assert.rejects(sqlFile('rollback-check.sql'), /ROLLBACK_PENDING_DELETIONS/);
    assert.equal((await audit('deletions')).pending, 1);
    await stack.command(
      ['up', '-d', '--no-deps', '--wait', '--wait-timeout', '60', 'euchre'],
      true
    );
    euchre = await main.connect('/euchre', '/euchre/socket.io');
    assert(
      (await ack(euchre.socket, 'command', { type: 'watch', code: table.code, token: table.token }))
        .ok
    );
    await until(
      async () => (await audit('deletions')).pending === 0,
      'Pending deletion did not finish',
      90000
    );
    assert.equal((await removed.request('account/session')).user, null);
    console.log('Pending deletion refused rollback, then completed through both game callbacks.');
    // Normal user actions finish these synthetic matches before the ownership switch.
    assert.equal((await ack(multi.socket, 'concede')).status, 'terminated');
    assert((await ack(euchre.socket, 'command', { type: 'leave' })).ok);
    await until(async () => {
      try {
        await sqlFile('rollback-check.sql');
        return true;
      } catch {
        return false;
      }
    }, 'Synthetic multiplayer did not drain');
    const results = await main.request('euchre/multiplayer-results');
    const profile = await main.request('account/session');
    await stack.command(['stop', 'gateway', 'accounts', 'hearts', 'euchre'], true);
    for (const socket of sockets) socket.disconnect();
    await sqlFile('rollback-prepare.sql');
    await audit('capture');
    await stack.topology('legacy');
    assert.equal((await main.request('account/session')).user.id, profile.user.id);
    assert.equal((await main.request('account/session')).user.preferences.card_style, 'flourish');
    assert.deepEqual(await main.request('hearts/games/' + solo.game_id), soloState);
    assert.deepEqual(await main.request('euchre/multiplayer-results'), results);
    const resumed = await main.connect('/game', '/hearts/socket.io', { game_id: solo.game_id });
    await until(() => resumed.state(), 'Combined rollback did not resume the saved solo game');
    resumed.socket.disconnect();
    const preserved = await audit('verify');
    const legacyUser = actor();
    await legacyUser.register();
    assert(legacyUser.id > removed.id, 'Legacy allocator reused an ID after split deletion');
    await stack.command(['stop', 'gateway', 'legacy'], true);
    await sqlFile('rollforward-prepare.sql');
    await stack.topology('split');
    assert.equal((await legacyUser.request('account/session')).user.name, legacyUser.username);
    const splitUser = actor();
    await splitUser.register();
    assert(splitUser.id > legacyUser.id, 'Split allocator reused a legacy ID');
    assert.equal((await main.request('account/session')).user.id, profile.user.id);
    assert.deepEqual(await main.request('hearts/games/' + solo.game_id), soloState);
    return {
      frontends,
      sharedAccounts: true,
      splitCreatedSoloRecoveredAfterRollback: true,
      gameResultsAndPreferencesPreserved: true,
      activeMultiplayerRefused: true,
      pendingDeletionRefused: true,
      pendingDeletionCompleted: true,
      quietBoundaryRollback: true,
      rollbackRecordAudit: preserved,
      rollforwardAfterRollback: true,
      accountIdsRemainMonotonic: true,
    };
  } finally {
    for (const socket of sockets) socket.disconnect();
  }
}
