// Real HTTP and Socket.IO clients through the checked-in gateway and dev proxies.
// Uses only disposable in-memory account/game data and loopback listeners.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hearts = resolve(root, '../hearts');
const euchre = resolve(root, '../euchre');
const require = createRequire(resolve(hearts, 'web/package.json'));
const { io } = require('socket.io-client');
const { createServer: createViteServer } = await import(
  pathToFileURL(resolve(hearts, 'web/node_modules/vite/dist/node/index.js'))
);
const nginx = process.env.NGINX_BIN || 'nginx';
const python =
  process.env.HEARTS_PYTHON ||
  resolve(
    hearts,
    'api',
    process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python'
  );
const origin = 'http://localhost:3000';
const open = new Set();

async function freePort() {
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

function start(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: root,
    windowsHide: true,
    ...options,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (chunk) => {
    logs = (logs + chunk).slice(-20000);
  });
  child.stderr.on('data', (chunk) => {
    logs = (logs + chunk).slice(-20000);
  });
  child.on('error', (error) => {
    logs += error.message;
  });
  return {
    child,
    logs: () => logs,
    async close() {
      if (child.exitCode === null && child.signalCode === null && child.pid) {
        child.kill();
        await once(child, 'exit');
      }
    },
  };
}

async function ready(url, process) {
  let lastError;
  for (let attempt = 0; attempt < 200; attempt++) {
    if (process.child.exitCode !== null || !process.child.pid) throw new Error(process.logs());
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(500) })).ok) return;
    } catch (error) {
      lastError = error.cause || error;
    }
    await delay(100);
  }
  throw new Error(`Service did not start: ${url}\n${lastError}\n${process.logs()}`);
}

async function connect(base, namespace, path, options = {}, event = 'connect') {
  const socket = io(base + namespace, {
    path,
    autoConnect: false,
    forceNew: true,
    reconnection: false,
    timeout: 4000,
    extraHeaders: { Origin: origin },
    ...options,
  });
  open.add(socket);
  const result = new Promise((resolveEvent, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out: ${namespace} on ${base}${path} (${event})`)),
      6000
    );
    socket.once(event, (data) => {
      clearTimeout(timer);
      resolveEvent(data);
    });
    socket.once('connect_error', (error) => {
      clearTimeout(timer);
      error.message = `${namespace} on ${base}${path}: ${error.message}`;
      reject(error);
    });
  });
  socket.connect();
  try {
    return { socket, data: await result };
  } catch (error) {
    socket.disconnect();
    throw error;
  }
}

function command(socket, data) {
  return new Promise((resolveReply, reject) =>
    socket
      .timeout(4000)
      .emit('command', data, (error, reply) => (error ? reject(error) : resolveReply(reply)))
  );
}

async function getJson(base, path, options = {}) {
  const response = await fetch(base + path, { redirect: 'manual', ...options });
  return { response, data: await response.json() };
}

async function checkHttp(base, game) {
  for (const [path, expected] of [
    [game === 'euchre' ? '/api/account/session' : '/api/health', 200],
    ...(game !== 'euchre' ? [['/api/hearts/health', 200]] : []),
    ...(game !== 'hearts'
      ? [
          ['/api/euchre/leaderboard?category=invalid-routing-check', 400],
          ['/api/account/euchre/leaderboard?category=invalid-routing-check', 400],
        ]
      : []),
  ])
    assert.equal((await fetch(base + path)).status, expected, base + path);
  const prefix = game === 'euchre' ? '/api/euchre' : '/api/hearts';
  const probe = await getJson(
    base,
    prefix + '/__routing_probe?value=one%20two&next=%2Fgame%3Fx%3D1',
    {
      method: 'POST',
      headers: {
        Origin: origin,
        Cookie: 'routing_probe=preserved',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ action: 'preserved' }),
    }
  );
  assert.equal(probe.response.status, 200);
  assert.deepEqual(probe.data, {
    path: game === 'euchre' ? '/account/euchre/__routing_probe' : '/__routing_probe',
    query: { value: 'one two', next: '/game?x=1' },
    cookie: 'preserved',
    origin,
    body: { action: 'preserved' },
  });
}

async function checkEuchre(base, path, transports, addTrailingSlash = true) {
  const { response: guest, data: session } = await getJson(base, '/api/account/session');
  const cookie = guest.headers.get('set-cookie').split(';')[0];
  const login = await getJson(base, '/api/account/login', {
    method: 'POST',
    headers: {
      Cookie: cookie,
      Origin: origin,
      'Content-Type': 'application/json',
      'X-CSRF-Token': session.csrf_token,
    },
    body: JSON.stringify({ username: 'routing_user', password: 'routing-test-password' }),
  });
  assert.equal(login.response.status, 200);
  const signedCookie = login.response.headers.get('set-cookie').split(';')[0];
  const options = {
    transports,
    addTrailingSlash,
    extraHeaders: { Origin: origin, Cookie: signedCookie },
    auth: { csrf: login.data.csrf_token },
  };
  const { socket } = await connect(base, '/euchre', path, options);
  const pendingState = once(socket, 'state');
  const created = await command(socket, { type: 'create' });
  assert.equal(created.ok, true, JSON.stringify(created));
  const [state] = await pendingState;
  assert.equal(state.lobby.memberName, 'routing_user', 'Cookie identity survives the transport');
  socket.disconnect();
  const resumed = await connect(base, '/euchre', path, options);
  assert.equal(
    (await command(resumed.socket, { type: 'watch', code: created.code, token: created.token })).ok,
    true
  );
  assert.equal((await command(resumed.socket, { type: 'close' })).ok, true);
  if (transports.length > 1 && resumed.socket.io.engine.transport.name !== 'websocket') {
    await Promise.race([
      once(resumed.socket.io.engine, 'upgrade'),
      delay(4000).then(() => {
        throw new Error('WebSocket upgrade failed');
      }),
    ]);
  }
  assert.equal(
    resumed.socket.io.engine.transport.name,
    transports.length > 1 ? 'websocket' : transports[0]
  );
  resumed.socket.disconnect();
  // An authenticated cookie must not allow a handshake with a missing CSRF token.
  await assert.rejects(connect(base, '/euchre', path, { ...options, auth: {} }), /rejected/);
}

async function checkHearts(base, path, otherPath = '/socket.io') {
  const solo = await getJson(base, '/api/hearts/games/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"seed":42}',
  });
  assert.equal(solo.response.status, 201);
  const single = await connect(
    base,
    '/game',
    path,
    { query: { game_id: solo.data.game_id } },
    'state'
  );
  assert.ok(single.data.players.length);
  single.socket.disconnect();
  const lobby = await getJson(base, '/api/hearts/lobbies/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"host_name":"Routing host"}',
  });
  assert.equal(lobby.response.status, 201);
  const joined = await connect(
    base,
    '/lobby',
    path,
    {
      auth: { lobby_code: lobby.data.code, player_token: lobby.data.player_token },
      query: { lobby_code: 'stale-transport-query' },
    },
    'lobby_session'
  );
  assert.equal(joined.data.player_token, lobby.data.player_token);
  const started = once(joined.socket, 'game_started');
  joined.socket.emit('start_game', { difficulty: 'easy' });
  const [game] = await started;
  const multi = await connect(
    base,
    '/multi',
    path,
    { query: { game_id: game.game_id, player_token: lobby.data.player_token } },
    'state'
  );
  assert.ok(multi.data.players.length);
  // Exercise the real client's Manager cache, separately from the independent
  // test connections above. Matching Hearts paths permit multiplexing; another
  // game's transport path must receive a different Manager on the same origin.
  const lobbyManager = io(base + '/lobby', { path, autoConnect: false });
  const multiManager = io(base + '/multi', { path, autoConnect: false });
  const otherManager = io(base + '/euchre', { path: otherPath, autoConnect: false });
  assert.equal(lobbyManager.io, multiManager.io);
  assert.notEqual(otherManager.io, multiManager.io);
  for (const client of [lobbyManager, multiManager, otherManager]) client.disconnect();
  multi.socket.disconnect();
  joined.socket.disconnect();
}

test(
  'game routing compatibility through real gateway and development proxies',
  { timeout: 180000 },
  async (t) => {
    const cleanups = [];
    await mkdir(resolve(root, '.local'), { recursive: true });
    const temp = await mkdtemp(resolve(root, '.local/routing-check-'));
    const backendPort = await freePort();
    const backend = start(python, [
      resolve(root, 'scripts/routing-fixture.py'),
      resolve(hearts, 'api'),
      String(backendPort),
    ]);
    cleanups.push(() => backend.close());
    try {
      await ready(`http://127.0.0.1:${backendPort}/health`, backend);
      const target = `http://127.0.0.1:${backendPort}`;
      const hubPort = await freePort();
      const hub = start(process.execPath, ['scripts/serve.mjs'], {
        env: { ...process.env, PORT: String(hubPort), HOST: '127.0.0.1', CARDS_API_TARGET: target },
      });
      cleanups.push(() => hub.close());
      await ready(`http://127.0.0.1:${hubPort}/api/health`, hub);

      const savedEnv = {
        CARDS_API_TARGET: process.env.CARDS_API_TARGET,
        ACCOUNT_PROXY_TARGET: process.env.ACCOUNT_PROXY_TARGET,
      };
      process.env.CARDS_API_TARGET = target;
      process.env.ACCOUNT_PROXY_TARGET = target;
      const vites = [];
      try {
        for (const project of [hearts, euchre]) {
          const vite = await createViteServer({
            root: resolve(project, 'web'),
            configFile: resolve(project, 'web/vite.config.ts'),
            mode: 'test',
            logLevel: 'error',
            cacheDir: resolve(temp, 'vite-' + vites.length),
            optimizeDeps: { noDiscovery: true, include: [] },
            server: { host: '127.0.0.1', port: 0, strictPort: false },
          });
          await vite.listen();
          vites.push(`http://127.0.0.1:${vite.httpServer.address().port}`);
          cleanups.push(() => vite.close());
        }
      } finally {
        for (const [key, value] of Object.entries(savedEnv)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }

      // Render only machine-specific paths/upstream addresses. Routing rules are
      // taken directly from the shipped config, including legacy virtual hosts.
      const gatewayPort = await freePort();
      const standalonePort = await freePort();
      const euchreWebPort = await freePort();
      const page = createServer((req, res) =>
        res.writeHead(200, { 'Content-Type': 'text/html' }).end('<html>game page</html>')
      ).listen(0, '127.0.0.1');
      await once(page, 'listening');
      cleanups.push(() => new Promise((resolveClose) => page.close(resolveClose)));
      const pageTarget = `127.0.0.1:${page.address().port}`;
      const unix = (path) => path.replaceAll('\\', '/');
      const localPath = (name) => unix(resolve(temp, name));
      const include = (source) =>
        source
          .replaceAll('/etc/nginx/cards-proxy.conf', localPath('proxy.conf'))
          .replaceAll('/etc/nginx/cards-api-proxy.conf', localPath('api.conf'))
          .replaceAll('/etc/nginx/cards-socket-proxy.conf', localPath('socket.conf'))
          .replace(/include ([^;]+);/g, 'include "$1";');
      await writeFile(
        resolve(temp, 'proxy.conf'),
        include(
          (
            await readFile(resolve(root, 'deploy/proxy.conf'), 'utf8')
          ).replaceAll('cards-api:5000', `127.0.0.1:${backendPort}`)
        )
      );
      await writeFile(
        resolve(temp, 'api.conf'),
        await readFile(resolve(root, 'deploy/api-proxy.conf'))
      );
      await writeFile(
        resolve(temp, 'socket.conf'),
        await readFile(resolve(root, 'deploy/socket-proxy.conf'))
      );
      const gateway = include(
        (await readFile(resolve(root, 'deploy/nginx.conf'), 'utf8'))
          .replaceAll('${CARDS_DNS_RESOLVER}', '127.0.0.1')
          .replaceAll('listen 8080', `listen 127.0.0.1:${gatewayPort}`)
          .replaceAll('root /usr/share/nginx/html;', `root "${unix(resolve(root, 'public'))}";`)
          .replaceAll('hearts-web:80', pageTarget)
          .replaceAll('euchre-web:3002', pageTarget)
      );
      const standalone = (await readFile(resolve(hearts, 'web/nginx.conf'), 'utf8'))
        .replace('listen 80;', `listen 127.0.0.1:${standalonePort};`)
        .replaceAll('api:5000', `127.0.0.1:${backendPort}`)
        .replace('root /usr/share/nginx/html;', `root "${unix(resolve(root, 'public'))}";`);
      const euchreWeb = (await readFile(resolve(euchre, 'web/nginx.conf'), 'utf8'))
        .replace('listen 3002;', `listen 127.0.0.1:${euchreWebPort};`)
        .replace('root /usr/share/nginx/html;', `root "${unix(resolve(root, 'public'))}";`);
      await mkdir(resolve(temp, 'logs'));
      await mkdir(resolve(temp, 'temp'));
      const config = `daemon off; master_process off;\npid "${localPath(
        'nginx.pid'
      )}";\nerror_log "${localPath(
        'error.log'
      )}" error;\nevents { worker_connections 256; }\nhttp { access_log off;\n${gateway}\n${standalone}\n${euchreWeb}\n}\n`;
      await writeFile(resolve(temp, 'nginx.conf'), config);
      const proxy = start(nginx, ['-p', unix(temp) + '/', '-c', localPath('nginx.conf')]);
      cleanups.push(() => proxy.close());
      await ready(`http://127.0.0.1:${gatewayPort}/api/health`, proxy);

      const proxies = [
        ['Cards gateway', `http://127.0.0.1:${gatewayPort}`, 'both'],
        ['Cards Node preview', `http://127.0.0.1:${hubPort}`, 'both'],
        ['Hearts Vite', vites[0], 'hearts'],
        ['Euchre Vite', vites[1], 'euchre'],
        ['Hearts standalone Nginx', `http://127.0.0.1:${standalonePort}`, 'hearts'],
      ];
      assert.equal((await fetch(target + '/_internal/private-probe')).status, 200);
      await t.test('private APIs stay unreachable through every public proxy', async () => {
        for (const base of [...proxies.map(([, base]) => base), `http://127.0.0.1:${euchreWebPort}`]) {
          for (const prefix of ['', '/api', '/api/hearts', '/api/euchre', '/api/account', '/api/account/euchre', '/hearts', '/euchre']) {
            for (const segment of ['_internal', '%5finternal', '%255finternal']) {
              const response = await fetch(base + prefix + '/' + segment + '/private-probe', {
                redirect: 'manual', headers: { 'X-Cards-Service': 'accounts', Authorization: 'Bearer fixture-private-token' }
              });
              assert.equal(response.status, 404, base + prefix + '/' + segment);
            }
          }
        }
      });
      for (const [label, base, game] of proxies) {
        await t.test(label, { timeout: 30000 }, async () => {
          await checkHttp(base, game);
          await assert.rejects(
            connect(base, '/__routing_reload', '/socket.io'),
            (error) =>
              error.data?.code === 'CLIENT_RELOAD_REQUIRED' &&
              error.message.includes('This page has been updated. Please reload to reconnect.')
          );
          const path = game === 'hearts' ? '/hearts/socket.io' : '/euchre/socket.io';
          // Test actual polling POSTs, WebSocket-only, and polling upgrades;
          // slashless polling avoids a redirect that could lose POST bodies.
          await checkEuchre(base, path, ['polling'], false);
          await checkEuchre(base, path, ['websocket']);
          await checkEuchre(base, path, ['polling', 'websocket']);
          await checkEuchre(base, '/socket.io', ['polling', 'websocket']);
          if (game !== 'euchre')
            await checkHearts(
              base,
              '/hearts/socket.io',
              game === 'both' ? '/euchre/socket.io' : '/socket.io'
            );
          if (game !== 'euchre') await checkHearts(base, '/socket.io', '/hearts/socket.io');
          if (game === 'both') {
            assert.equal(
              (await fetch(base + '/hearts/game/lobby/INVITE?from=test', { redirect: 'manual' }))
                .status,
              label.includes('preview') ? 308 : 200
            );
          }
        });
      }
      await t.test('standalone Euchre reports unavailable transport as JSON', async () => {
        for (const path of [
          '/socket.io',
          '/socket.io/',
          '/euchre/socket.io',
          '/euchre/socket.io/',
          '/api/euchre/leaderboard',
        ]) {
          const response = await fetch(`http://127.0.0.1:${euchreWebPort}${path}`);
          assert.equal(response.status, 503);
          assert.match(response.headers.get('content-type'), /application\/json/);
        }
      });
    } finally {
      for (const socket of open) socket.disconnect();
      for (const close of cleanups.reverse()) await close();
    }
  }
);
