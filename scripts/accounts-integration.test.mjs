// Real independent account/game processes, HTTP and JavaScript Socket.IO clients.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '..');
const pythonPath = (project) => resolve(root, project, process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python');
const require = createRequire(resolve(root, '../hearts/web/package.json'));
const { io } = require('socket.io-client');
const origin = 'http://localhost:3000';
const secret = randomBytes(32).toString('hex');

async function freePort() {
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}
function start(python, args) {
  const child = spawn(python, ['scripts/accounts-fixture.py', ...args], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (data) => { logs = (logs + data).slice(-18000); });
  child.on('error', (error) => { logs += error.message; });
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

test('shared accounts across both games, revocation, outages and durable deletion', { timeout: 120000 }, async () => {
  await mkdir(resolve(root, '.local'), { recursive: true });
  const temp = await mkdtemp(resolve(root, '.local/accounts-integration-'));
  const accountsPort = await freePort(), gamePort = await freePort();
  const accountBase = `http://127.0.0.1:${accountsPort}`, gameBase = `http://127.0.0.1:${gamePort}`;
  const common = [resolve(temp, 'rehearsal.db'), '', String(accountsPort), String(gamePort), secret];
  const accountArgs = ['accounts', ...common]; accountArgs[2] = String(accountsPort);
  const gameArgs = ['games', ...common]; gameArgs[2] = String(gamePort);
  let accounts = start(pythonPath('api'), accountArgs), games;
  const sockets = [];
  let cookie = '', csrf = '';
  async function session() {
    const response = await fetch(gameBase + '/account/session', { headers: { Cookie: cookie } });
    assert.equal(response.status, 200);
    cookie = response.headers.get('set-cookie')?.split(';')[0] || cookie;
    const data = await response.json(); csrf = data.csrf_token; return data;
  }
  async function account(path, data = {}) {
    await session();
    const response = await fetch(gameBase + '/account/' + path, { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    cookie = response.headers.get('set-cookie')?.split(';')[0] || cookie;
    return { status: response.status, ...await response.json() };
  }
  async function login(password = 'rehearsal-password-123') {
    const result = await account('login', { username: 'rehearsal', password });
    assert.equal(result.status, 200); assert.equal(result.user.id, '42'); csrf = result.csrf_token; return result;
  }
  async function game(path, data, credentials = cookie) {
    return fetch(gameBase + path, { method: data ? 'POST' : 'GET', headers: { Cookie: credentials, Origin: origin, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' }, ...(data ? { body: JSON.stringify(data) } : {}) });
  }
  async function connect(namespace, auth = {}, query = {}, credentials = cookie) {
    const socket = io(gameBase + namespace, { forceNew: true, reconnection: false, transports: ['websocket'], extraHeaders: { Cookie: credentials, Origin: origin }, auth: { csrf, ...auth }, query, timeout: 4000 });
    sockets.push(socket);
    await new Promise((done, reject) => { socket.once('connect', done); socket.once('connect_error', reject); });
    return socket;
  }
  const command = (socket, data) => new Promise((done, reject) => socket.timeout(4000).emit('command', data, (error, result) => error ? reject(error) : done(result)));
  async function control(action) {
    const response = await fetch(accountBase + '/_internal/test/control', { method: 'POST', headers: { 'X-Test-Key': secret, 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) });
    assert.equal(response.status, 200); return response.json();
  }
  async function mailToken(view = 'reset') {
    const entries = await Promise.all((await readdir(resolve(temp, 'outbox'))).map(async name => JSON.parse(await readFile(resolve(temp, 'outbox', name), 'utf8'))));
    const entry = entries.filter(value => new URL(value.url).searchParams.get('view') === view).at(-1);
    return new URL(entry.url).searchParams.get('token');
  }
  try {
    await ready(accountBase, accounts);
    games = start(pythonPath('../hearts/api'), gameArgs);
    await ready(gameBase, games);
    const signed = await login();
    const legacyResponse = await fetch(gameBase + '/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ username: 'rehearsal', password: 'rehearsal-password-123' }) });
    assert.equal(legacyResponse.status, 200);
    const legacy = (await legacyResponse.json()).token;
    const legacyPreferences = () => fetch(gameBase + '/preferences', { headers: { Authorization: 'Bearer ' + legacy } });
    assert.equal((await legacyPreferences()).status, 200);
    assert.equal(signed.user.preferences.card_style, 'flourish');
    assert.equal((await game('/preferences')).status, 200);
    const soloResponse = await game('/games/start', { difficulty: 'easy', seed: 7 });
    assert.equal(soloResponse.status, 201);
    const solo = await soloResponse.json();
    const soloSocket = await connect('/game', {}, { game_id: solo.game_id });
    const lobbyResponse = await game('/lobbies/create', { host_name: 'rehearsal' });
    assert.equal(lobbyResponse.status, 201);
    const lobby = await lobbyResponse.json();
    const heartsSocket = await connect('/lobby', { lobby_code: lobby.code, player_token: lobby.player_token });
    const euchre = await connect('/euchre');
    const table = await command(euchre, { type: 'create', name: 'rehearsal' });
    assert.equal(table.ok, true);
    assert.equal((await command(euchre, { type: 'start', difficulty: 'easy' })).ok, true);
    assert.equal((await game('/leaderboard?category=easy')).status, 200);
    assert.equal((await game('/account/euchre/leaderboard')).status, 200);
    assert.equal((await game('/preferences', { card_style: 'standard' }, cookie)).status, 405);
    const csrfFailure = await fetch(gameBase + '/preferences', { method: 'PATCH', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(csrfFailure.status, 403);

    // A real accounts process restart leaves connected games/guests intact.
    const guest = await connect('/euchre', {}, {}, '');
    await accounts.close();
    const unavailable = await command(euchre, { type: 'watch', code: table.code, token: table.token });
    assert.equal(unavailable.code, 'ACCOUNTS_UNAVAILABLE');
    assert.equal((await game('/preferences')).status, 503);
    assert.equal((await command(guest, { type: 'create', name: 'Guest' })).ok, true);
    assert(soloSocket.connected && heartsSocket.connected && euchre.connected);
    accounts = start(pythonPath('api'), accountArgs);
    await ready(accountBase, accounts);
    assert.equal((await command(euchre, { type: 'watch', code: table.code, token: table.token })).ok, true);
    await account('logout');
    assert.equal((await command(euchre, { type: 'watch', code: table.code, token: table.token })).ok, false);
    await login();
    await control('expire');
    assert.equal((await session()).user, null);
    await login();
    await account('forgot-password', { email: 'rehearsal@example.test' });
    const token = await mailToken();
    assert.equal((await account('reset-password', { token, password: 'replacement-password-123' })).status, 200);
    assert.equal((await legacyPreferences()).status, 401);
    assert.equal((await session()).user, null);
    await login('replacement-password-123');
    assert.equal((await account('profile', { email: 'changed@example.test' })).user, null);
    assert.equal((await game('/preferences')).status, 401);
    assert.equal((await account('login', { username: 'rehearsal', password: 'replacement-password-123' })).status, 403);
    assert.equal((await account('verify-email', { token: await mailToken('verify') })).status, 200);
    await login('replacement-password-123');
    await control('euchre-offline');
    const deleted = await account('delete', { password: 'replacement-password-123' });
    assert.equal(deleted.status, 202); assert.equal(deleted.code, 'DELETION_PENDING'); assert.equal(deleted.user, null);
    assert.equal((await account('login', { username: 'rehearsal', password: 'replacement-password-123' })).status, 403);
    const state = await (await fetch(gameBase + '/_internal/test/state', { headers: { 'X-Test-Key': secret } })).json();
    assert.equal(state.solo + state.preferences + state.stats, 0);
    assert.equal((await control('retry')).user_exists, false);
    const cleaned = await (await fetch(gameBase + '/_internal/test/state', { headers: { 'X-Test-Key': secret } })).json();
    assert(!JSON.stringify(cleaned).includes('rehearsal'));
    assert(!JSON.stringify(cleaned.tables).includes(table.token));
    assert(!JSON.stringify(cleaned.cached).includes(table.token));
    assert.equal((await control('retry')).jobs[0].status, 'completed');
  } catch (error) {
    error.message += '\nACCOUNTS: ' + accounts.logs() + '\nGAMES: ' + games?.logs();
    throw error;
  } finally {
    for (const socket of sockets) socket.disconnect();
    await games?.close(); await accounts.close();
  }
});
