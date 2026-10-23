import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { io } from 'socket.io-client';

const emit = (socket, event, ...data) =>
  new Promise((done, reject) =>
    socket
      .timeout(5000)
      .emit(event, ...data, (error, reply) => (error ? reject(error) : done(reply)))
  );
async function until(predicate, message, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await delay(50);
  }
  throw new Error(message);
}

// This checks public contracts only. Native processes and pinned containers use the same probe.
export async function verifySplitStack(stack) {
  const base = stack.base('gateway');
  const origin = base.replace('127.0.0.1', 'localhost');
  const sockets = [];
  let cookie = '',
    csrf;
  const username = 'split_' + randomBytes(5).toString('hex');
  const password = 'isolated-rehearsal-password-123';
  async function request(path, data, method = data === undefined ? 'GET' : 'POST', expectedStatus) {
    const response = await fetch(base + path, {
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
    const value = await response.json();
    assert(response.ok, `${path}: ${response.status} ${value.error || ''}`);
    if (expectedStatus) assert.equal(response.status, expectedStatus, path);
    if (value.csrf_token) csrf = value.csrf_token;
    return value;
  }
  async function connect(
    namespace,
    path,
    query = {},
    credentials = cookie,
    transports = ['websocket']
  ) {
    const socket = io(base + namespace, {
      path,
      query,
      auth: { ...query, csrf },
      forceNew: true,
      reconnection: false,
      transports,
      timeout: 5000,
      extraHeaders: { Cookie: credentials, Origin: origin },
    });
    sockets.push(socket);
    let latest;
    socket.on('state', (value) => {
      latest = value;
    });
    await new Promise((done, reject) => {
      socket.once('connect', done);
      socket.once('connect_error', reject);
    });
    return { socket, state: () => latest };
  }
  const pids = async () =>
    Object.fromEntries(
      await Promise.all(
        ['accounts', 'hearts', 'euchre', 'gateway'].map(async (role) => [
          role,
          await stack.identity(role),
        ])
      )
    );
  async function restartOnly(role, connected) {
    const before = await pids();
    await stack.restart(role);
    const after = await pids();
    assert.notEqual(after[role], before[role], `${role} was actually replaced`);
    for (const other of ['accounts', 'hearts', 'euchre', 'gateway'].filter(
      (value) => value !== role
    ))
      assert.equal(after[other], before[other], `${role} must not restart ${other}`);
    if (connected) assert(connected.socket.connected, `${role} disconnected the other game`);
    assert.equal((await request('/api/account/session')).user.name, username);
  }
  try {
    for (const [role, component] of [
      ['accounts', 'cards-accounts'],
      ['hearts', 'hearts-game'],
      ['euchre', 'euchre-game'],
    ]) {
      const value = await stack.health(role);
      assert.equal(value.component, component);
      assert(value.version && value.revision);
    }
    await request('/api/account/session');
    await request('/api/account/register', {
      username,
      email: username + '@example.test',
      password,
    });
    const mail = await until(
      async () =>
        (
          await stack.mail()
        ).find(
          (value) =>
            value.to === username + '@example.test' &&
            new URL(value.url).searchParams.get('view') === 'verify'
        ),
      'Verification email was not written to the isolated outbox'
    );
    await request('/api/account/verify-email', {
      token: new URL(mail.url).searchParams.get('token'),
    });
    await request('/api/account/login', { username, password });
    const session = await request('/api/account/session');
    assert.equal(session.user.name, username);
    await request('/api/hearts/preferences', { card_style: 'flourish' }, 'PATCH');
    assert.equal((await request('/api/account/session')).user.preferences.card_style, 'flourish');
    assert.equal((await request('/api/preferences')).preferences.card_style, 'flourish');
    for (const path of ['/api/account/euchre/leaderboard', '/api/euchre/leaderboard'])
      assert((await request(path)).all_time);
    for (const path of [
      '/api/_internal/accounts/v1/profiles',
      '/api/hearts/_internal/games/v1/hearts/delete-user',
      '/api/euchre/_internal/games/v1/euchre/delete-user',
      '/api/hearts/%255finternal/accounts/v1/session',
    ])
      assert.equal((await fetch(base + path, { method: 'POST' })).status, 404);
    assert.equal((await fetch(base + '/socket.io/?EIO=4&transport=polling')).status, 426);
    const solo = await request('/api/hearts/games/start', { difficulty: 'easy', seed: 17 });
    await stack.checkWebRoutes?.({ cookie, csrf, origin, solo, username });
    const soloState = await request('/api/games/' + solo.game_id);
    let hearts = await connect('/game', '/hearts/socket.io', { game_id: solo.game_id });
    const euchre = await connect('/euchre', '/euchre/socket.io', {}, cookie, [
      'polling',
      'websocket',
    ]);
    const table = await emit(euchre.socket, 'command', { type: 'create' });
    assert(table.ok);
    assert((await emit(euchre.socket, 'command', { type: 'start', difficulty: 'easy' })).ok);
    await until(
      () => euchre.state()?.game?.turn === 0 && euchre.state()?.game?.phase !== 'trick_complete',
      'Euchre did not reach a human turn'
    );
    await until(
      () => euchre.socket.io.engine.transport.name === 'websocket',
      'Polling did not upgrade to WebSocket'
    );
    const euchreState = structuredClone(euchre.state().game);
    await restartOnly('hearts', euchre);
    assert.deepEqual(euchre.state().game, euchreState);
    assert.deepEqual(await request('/api/hearts/games/' + solo.game_id), soloState);
    hearts = await connect('/game', '/hearts/socket.io', { game_id: solo.game_id });
    const heartsState = structuredClone(hearts.state());
    await restartOnly('euchre', hearts);
    assert.deepEqual(hearts.state(), heartsState);
    const returned = await connect('/euchre', '/euchre/socket.io');
    assert(
      (
        await emit(returned.socket, 'command', {
          type: 'watch',
          code: table.code,
          token: table.token,
        })
      ).ok
    );
    assert.deepEqual(returned.state().game, euchreState);
    const guest = await connect('/euchre', '/euchre/socket.io', {}, '');
    await restartOnly('accounts', hearts);
    assert(returned.socket.connected && guest.socket.connected);
    assert((await emit(guest.socket, 'command', { type: 'create', name: 'Guest' })).ok);
    assert(
      (
        await emit(returned.socket, 'command', {
          type: 'watch',
          code: table.code,
          token: table.token,
        })
      ).ok
    );
    for (const socket of sockets) socket.disconnect();
    await restartOnly('gateway');
    assert.equal((await request('/api/hearts/games/active')).game_id, solo.game_id);
    await request('/api/account/delete', { password }, 'POST', 200);
    await until(
      async () => (await request('/api/account/session')).user === null,
      'Account deletion did not complete'
    );
    assert.equal(
      (await fetch(base + '/api/hearts/stats', { headers: { Cookie: cookie } })).status,
      401
    );
    return {
      components: 4,
      sharedLogin: true,
      independentRestarts: true,
      recovery: true,
      deletion: true,
    };
  } finally {
    for (const socket of sockets) socket.disconnect();
  }
}
