// Separate account, Hearts-only, and independent Euchre processes; disposable DB only.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '..');
const require = createRequire(resolve(root, '../euchre/web/package.json'));
const { io } = require('socket.io-client');
const engine = await import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(await readFile(resolve(root, '../euchre/web/src/game/engine.ts'), 'utf8'))).toString('base64'));
const origin = 'http://localhost:3000', secret = randomBytes(32).toString('hex');
const python = (directory) => resolve(directory, process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python');
async function freePort() {
  const server = createServer().listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(done => server.close(done)); return port;
}
function start(executable, args) {
  const child = spawn(executable, args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { logs = (logs + data).slice(-18000); });
  child.on('error', error => { logs += error.message; });
  return { child, logs: () => logs, async close() { if (child.pid && child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); } } };
}
async function ready(base, process) {
  for (let n = 0; n < 150; n++) {
    if (!process.child.pid || process.child.exitCode !== null) throw new Error(process.logs());
    try { if ((await fetch(base + '/ready', { signal: AbortSignal.timeout(500) })).ok) return; } catch {}
    await delay(100);
  }
  throw new Error(process.logs());
}
const command = (socket, data) => new Promise((done, reject) => socket.timeout(4000).emit('command', data, (error, result) => error ? reject(error) : done(result)));
const heartsCommand = (socket, event, data) => new Promise((done, reject) => socket.timeout(4000).emit(event, ...(data === undefined ? [] : [data]), (error, result) => error ? reject(error) : done(result)));

test('independent game servers complete and recover games while the other stays connected', { timeout: 150000 }, async () => {
  await mkdir(resolve(root, '.local'), { recursive: true });
  const temp = await mkdtemp(resolve(root, '.local/euchre-integration-'));
  const db = resolve(temp, 'rehearsal.db');
  const accountPort = await freePort(), heartsPort = await freePort(), euchrePort = await freePort();
  const accountBase = `http://127.0.0.1:${accountPort}`, heartsBase = `http://127.0.0.1:${heartsPort}`, euchreBase = `http://127.0.0.1:${euchrePort}`;
  const common = [db, '', String(accountPort), String(heartsPort), secret, String(euchrePort)];
  const spawnCards = (role, port, directory) => { const args = [role, ...common]; args[2] = String(port); return start(python(resolve(root, directory)), ['scripts/accounts-fixture.py', ...args]); };
  const spawnEuchre = () => start(python(resolve(root, '../euchre/api')), ['../euchre/scripts/server-fixture.py', db, String(euchrePort), String(accountPort), secret]);
  const spawnHearts = () => start(python(resolve(root, '../hearts/game-api')), ['../hearts/scripts/game-server-fixture.py', db, String(heartsPort), String(accountPort), secret]);
  let accounts = spawnCards('accounts', accountPort, 'api'), hearts, euchre;
  let cookie = '', csrf = '';
  const sockets = [];
  async function account(path, data) {
    const session = await fetch(accountBase + '/account/session', { headers: { Cookie: cookie } });
    assert.equal(session.status, 200);
    cookie = session.headers.get('set-cookie')?.split(';')[0] || cookie;
    csrf = (await session.json()).csrf_token;
    const response = await fetch(accountBase + '/account/' + path, { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' }, body: JSON.stringify(data || {}) });
    cookie = response.headers.get('set-cookie')?.split(';')[0] || cookie;
    const reply = await response.json(); csrf = reply.csrf_token || csrf;
    return { status: response.status, ...reply };
  }
  async function connect(base, namespace, query = {}, credentials = cookie) {
    const socket = io(base + namespace, { forceNew: true, reconnection: false, transports: ['websocket'], extraHeaders: { Cookie: credentials, Origin: origin }, auth: { csrf, ...query }, query, timeout: 4000 });
    sockets.push(socket);
    let latest;
    socket.on('state', value => { latest = value; });
    await new Promise((done, reject) => { socket.once('connect', done); socket.once('connect_error', error => { error.message = namespace + ': ' + error.message; reject(error); }); });
    return { socket, state: () => latest };
  }
  async function state(base) { const response = await fetch(base + '/_internal/test/state', { headers: { 'X-Test-Key': secret } }); assert.equal(response.status, 200); return response.json(); }
  async function heartsRequest(path, data) {
    const response = await fetch(heartsBase + path, { method: data ? 'POST' : 'GET', headers: { Cookie: cookie, Origin: origin, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' }, ...(data ? { body: JSON.stringify(data) } : {}) });
    assert(response.ok, await response.clone().text()); return response.json();
  }
  try {
    await ready(accountBase, accounts);
    euchre = spawnEuchre(); await ready(euchreBase, euchre);
    hearts = spawnHearts(); await ready(heartsBase, hearts);
    assert.equal((await account('login', { username: 'rehearsal', password: 'rehearsal-password-123' })).user.id, '42');
    const legacyResponse = await fetch(accountBase + '/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ username: 'rehearsal', password: 'rehearsal-password-123' }) });
    assert.equal(legacyResponse.status, 200);
    const legacy = (await legacyResponse.json()).token;
    const legacyPreferences = () => fetch(heartsBase + '/preferences', { headers: { Authorization: 'Bearer ' + legacy } });
    assert.equal((await legacyPreferences()).status, 200);
    const solo = await heartsRequest('/games/start', { difficulty: 'easy', seed: 17 });
    let heartsClient = await connect(heartsBase, '/game', { game_id: solo.game_id });
    const heartsBefore = await heartsRequest('/games/' + solo.game_id);
    const connected = await connect(euchreBase, '/euchre');
    const group = await command(connected.socket, { type: 'create' }); assert.equal(group.ok, true);
    assert.equal((await command(connected.socket, { type: 'name', name: 'Saved Stars' })).ok, true);
    assert.equal(connected.state().lobby.memberName, 'rehearsal');
    const diskBefore = (await state(euchreBase)).tables[0];
    await euchre.close();
    assert(heartsClient.socket.connected);
    assert.deepEqual(await heartsRequest('/games/' + solo.game_id), heartsBefore);
    euchre = spawnEuchre(); await ready(euchreBase, euchre);
    assert.deepEqual((await state(euchreBase)).tables[0], diskBefore, 'restart must preserve credentials and table revision');
    let resumed = await connect(euchreBase, '/euchre');
    assert.equal((await command(resumed.socket, { type: 'watch', code: group.code, token: group.token })).ok, true);
    assert.equal(resumed.state().lobby.teams[0].name, 'Saved Stars');
    assert(!JSON.stringify(resumed.state()).includes(group.token));
    assert.equal((await command(resumed.socket, { type: 'start', difficulty: 'easy' })).ok, true);
    const humanDeadline = Date.now() + 10000;
    while (!resumed.state()?.game || resumed.state().game.turn !== 0 || resumed.state().game.phase === 'trick_complete') {
      assert(Date.now() < humanDeadline, 'Wait for a stable human turn before active-game restart');
      await delay(5);
    }
    const activeView = structuredClone(resumed.state().game);
    const activeDisk = (await state(euchreBase)).tables.find(table => table.code === group.code);
    await euchre.close();
    assert(heartsClient.socket.connected);
    euchre = spawnEuchre(); await ready(euchreBase, euchre);
    assert.deepEqual((await state(euchreBase)).tables.find(table => table.code === group.code), activeDisk);
    resumed = await connect(euchreBase, '/euchre');
    assert.equal((await command(resumed.socket, { type: 'watch', code: group.code, token: group.token })).ok, true);
    assert.deepEqual(resumed.state().game, activeView, 'active game retains hand, turn, dealer, and scores');
    const activeEuchre = structuredClone(resumed.state());
    await hearts.close();
    assert(resumed.socket.connected, 'an active Euchre match remains connected during a Hearts restart');
    hearts = spawnHearts(); await ready(heartsBase, hearts);
    assert.deepEqual(resumed.state(), activeEuchre, 'Hearts restart preserves the active Euchre hand, turn, and score');
    assert.deepEqual(await heartsRequest('/games/' + solo.game_id), heartsBefore);
    heartsClient = await connect(heartsBase, '/game', { game_id: solo.game_id });
    const deadline = Date.now() + 90000;
    let actions = 0;
    while (resumed.state()?.game?.phase !== 'game_over') {
      assert(Date.now() < deadline, 'Complete real Euchre match before timeout');
      const snapshot = resumed.state();
      const game = snapshot?.game;
      if (game?.phase === 'round_complete' || (game && game.turn === 0 && game.phase !== 'trick_complete')) {
        const legal = engine.legalActions(game);
        const action = legal.find(value => value.type === 'call' && !value.alone) || legal[0];
        if (action) {
          const result = await command(resumed.socket, { type: 'action', revision: snapshot.lobby.revision, action });
          assert.equal(result.ok, true, JSON.stringify(result)); actions++;
          // Exercise the production command throttle at a human-compatible rate.
          await delay(200);
        }
      }
      await delay(2);
    }
    assert(actions > 20);
    const finished = resumed.state().game;
    assert(Math.max(...finished.scores) >= 10);
    assert(finished.hands.slice(1).every(hand => hand.every(card => card === null)));
    const results = await (await fetch(euchreBase + '/account/euchre/multiplayer-results', { headers: { Cookie: cookie } })).json();
    assert.equal(results.results.length, 1);
    assert.deepEqual(results.results[0].scores, finished.scores);
    const finishedId = finished.id;
    assert.equal((await command(resumed.socket, { type: 'watch', code: group.code, token: group.token })).ok, true);
    assert.equal((await state(euchreBase)).results.filter(result => result.game_id === finishedId).length, 1);
    assert(heartsClient.socket.connected);
    assert.deepEqual(await heartsRequest('/games/' + solo.game_id), heartsBefore);

    const euchreBeforeHeartsRestart = structuredClone(resumed.state());
    const lobby = await heartsRequest('/lobbies/create', { host_name: 'rehearsal', num_ai: 3 });
    const host = await connect(heartsBase, '/lobby', { lobby_code: lobby.code, player_token: lobby.player_token });
    const started = new Promise((done, reject) => { host.socket.once('game_started', done); host.socket.once('error', reject); });
    host.socket.emit('start_game', { difficulty: 'easy' });
    const match = await started;
    let player = await connect(heartsBase, '/multi', { game_id: match.game_id, player_token: lobby.player_token });
    const humanBefore = structuredClone(player.state());
    const diskHearts = (await state(heartsBase)).games.find(game => game.game_id === match.game_id);
    await hearts.close();
    assert(resumed.socket.connected, 'Euchre retains its connection during a Hearts restart');
    assert.deepEqual(resumed.state(), euchreBeforeHeartsRestart);
    hearts = spawnHearts(); await ready(heartsBase, hearts);
    assert.deepEqual((await state(heartsBase)).games.find(game => game.game_id === match.game_id), diskHearts);
    assert.deepEqual(await heartsRequest('/games/' + solo.game_id), heartsBefore, 'solo save survives Hearts restart');
    player = await connect(heartsBase, '/multi', { game_id: match.game_id, player_token: lobby.player_token });
    assert.deepEqual(player.state(), humanBefore, 'Hearts recovers hand, turn, scores, and seat credentials');
    const spectator = await connect(heartsBase, '/multi', { game_id: match.game_id }, '');
    assert.equal(spectator.state().my_seat, null);
    assert.deepEqual(spectator.state().my_hand, []);
    assert(!JSON.stringify(spectator.state()).includes(lobby.player_token));
    const heartsDeadline = Date.now() + 60000;
    let heartsActions = 0;
    while (!player.state()?.game_over) {
      assert(Date.now() < heartsDeadline, 'Complete a real Hearts match');
      const view = player.state();
      if (view?.phase === 'passing' && !view.pass_submitted) {
        await heartsCommand(player.socket, 'pass', { cards: view.my_hand.slice(0, 3) }); heartsActions++;
      } else if (view?.legal_plays?.length) {
        await heartsCommand(player.socket, 'play', { card: view.legal_plays[0] }); heartsActions++;
      }
      await delay(5);
    }
    assert(heartsActions > 20);
    assert(resumed.socket.connected);
    assert.deepEqual(resumed.state(), euchreBeforeHeartsRestart);
    const heartsResults = (await state(heartsBase)).results.filter(result => result.difficulty === 'multiplayer');
    assert.equal(heartsResults.length, 1);
    player.socket.emit('request_state'); await delay(50);
    assert.equal((await state(heartsBase)).results.filter(result => result.difficulty === 'multiplayer').length, 1);
    const recoveredSolo = await connect(heartsBase, '/game', { game_id: solo.game_id });
    const legacySolo = await connect(heartsBase, '/game', { game_id: solo.game_id, auth_token: legacy }, '');
    assert.equal(legacySolo.state().players[0].icon, 'cat');
    const guestSoloResponse = await fetch(heartsBase + '/games/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ difficulty: 'easy', seed: 21 }) });
    const guestSolo = await connect(heartsBase, '/game', { game_id: (await guestSoloResponse.json()).game_id }, '');
    const guest = await connect(euchreBase, '/euchre', {}, '');
    await accounts.close();
    assert.equal((await command(resumed.socket, { type: 'watch', code: group.code, token: group.token })).code, 'ACCOUNTS_UNAVAILABLE');
    assert.equal((await command(guest.socket, { type: 'create', name: 'Guest' })).ok, true);
    assert.equal((await heartsCommand(recoveredSolo.socket, 'advance')).code, 'ACCOUNTS_UNAVAILABLE');
    await heartsCommand(guestSolo.socket, 'advance');
    assert(guestSolo.socket.connected);
    assert(recoveredSolo.socket.connected && resumed.socket.connected);
    accounts = spawnCards('accounts', accountPort, 'api'); await ready(accountBase, accounts);
    assert.equal((await command(resumed.socket, { type: 'watch', code: group.code, token: group.token })).ok, true);
    await account('logout');
    assert.equal((await command(resumed.socket, { type: 'rematch' })).ok, false);
    assert.equal((await heartsCommand(recoveredSolo.socket, 'advance')).ok, false);
    await account('login', { username: 'rehearsal', password: 'rehearsal-password-123' });
    await hearts.close();
    const removed = await account('delete', { password: 'rehearsal-password-123' });
    assert.equal(removed.status, 202);
    assert.equal(removed.code, 'DELETION_PENDING');
    hearts = spawnHearts(); await ready(heartsBase, hearts);
    const retried = await fetch(accountBase + '/_internal/test/control', { method: 'POST', headers: { 'X-Test-Key': secret, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'retry' }) });
    assert.equal((await retried.json()).user_exists, false);
    const cleaned = await state(euchreBase);
    assert.equal(cleaned.results.length, 0);
    assert(!JSON.stringify(cleaned.tables).includes('rehearsal'));
    assert(!JSON.stringify(cleaned.tables).includes(group.token));
    assert.equal((await state(heartsBase)).solo, 0);
    assert.equal((await state(heartsBase)).stats, 0);
    assert.equal((await legacyPreferences()).status, 401);
  } catch (error) {
    error.message += '\nACCOUNTS: ' + accounts.logs() + '\nHEARTS: ' + hearts?.logs() + '\nEUCHRE: ' + euchre?.logs(); throw error;
  } finally {
    for (const socket of sockets) socket.disconnect();
    await euchre?.close(); await hearts?.close(); await accounts.close();
  }
});
