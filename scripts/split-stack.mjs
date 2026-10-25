import { createServer } from 'node:net';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { startProcess, waitForService } from './service-process.mjs';

export const root = resolve(import.meta.dirname, '..');
const baseRoles = ['accounts', 'hearts', 'euchre'];
const paths = {
  accounts: resolve(root, 'api'),
  hearts: resolve(root, '../hearts/game-api'),
  euchre: resolve(root, '../euchre/api'),
  golf: resolve(root, '../golf/api'),
};
const key = () => randomBytes(40).toString('hex');
export async function freePort() {
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}

export function isolatedEnvironment(env = process.env) {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([name]) =>
        !/^(?:CARDS_|HEARTS_|EUCHRE_|GOLF_|DATABASE_URL$|JWT_SECRET$|SMTP|FLASK_|ADMIN_KEY$|CORS_ORIGINS$|FRONTEND_URL$|PGOPTIONS$)/i.test(
          name
        )
    )
  );
}

export async function stackSettings(directory, requestedPorts, golf = false) {
  const roles = [...baseRoles, ...(golf ? ['golf'] : [])];
  const local = resolve(root, '.local');
  const target = resolve(directory);
  if (dirname(target) !== local || !basename(target).startsWith('split-'))
    throw new Error('Use a dedicated Cards/.local/split-* directory.');
  await mkdir(target, { recursive: true });
  if ((await realpath(target)) !== resolve(await realpath(local), basename(target)))
    throw new Error('Split data cannot use a directory link.');
  const file = resolve(target, 'settings.json');
  let settings;
  if (existsSync(file)) {
    if ((await realpath(file)) !== file) throw new Error('Stack settings cannot use a file link.');
    settings = JSON.parse(await readFile(file, 'utf8'));
  } else {
    if (existsSync(resolve(target, 'state.sqlite')))
      throw new Error('Existing data has no stack settings; refusing to adopt it.');
    const ports =
      requestedPorts ||
      Object.fromEntries(
        await Promise.all(['gateway', ...roles].map(async (role) => [role, await freePort()]))
      );
    settings = {
      version: 1,
      ports,
      jwt: key(),
      read: { hearts: key(), euchre: key() },
      callbacks: { hearts: key(), euchre: key() },
    };
    await writeFile(file, JSON.stringify(settings, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  }
  if (
    settings.version !== 1 ||
    ![
      settings.jwt,
      ...Object.values(settings.read || {}),
      ...Object.values(settings.callbacks || {}),
    ].every((value) => typeof value === 'string' && value.length >= 40)
  )
    throw new Error('Invalid split-stack credentials.');
  if (golf && !settings.golfSecret) {
    settings.golfSecret = key();
    settings.read.golf = key();
    settings.callbacks.golf = key();
    settings.ports.golf = requestedPorts?.golf || settings.ports.golf || await freePort();
    await writeFile(file, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
  }
  if (golf && ![settings.golfSecret, settings.read.golf, settings.callbacks.golf].every(value => typeof value === 'string' && value.length >= 40))
    throw new Error('Invalid Golf service credentials.');
  const ports = ['gateway', ...roles].map((role) => settings.ports?.[role]);
  if (
    !ports.every((port) => Number.isInteger(port) && port > 1023 && port < 65536) ||
    new Set(ports).size !== ports.length
  )
    throw new Error('Split-stack ports must be distinct high ports.');
  return { file, directory: target, ...settings };
}

export async function startNativeStack({
  directory = resolve(root, '.local/split-dev'),
  ports,
  web = false,
  webPorts = { hearts: 3001, euchre: 3002 },
  echo = false,
  gateway = 'node',
  signal,
  onCreated,
  golf = false,
} = {}) {
  const roles = [...baseRoles, ...(golf ? ['golf'] : [])];
  const settings = await stackSettings(directory, ports, golf);
  for (const port of [...['gateway', ...roles].map(role => settings.ports[role]), ...(web ? Object.values(webPorts) : [])]) {
    const listener = createServer();
    try {
      listener.listen(port, '127.0.0.1');
      await once(listener, 'listening');
    } catch {
      throw new Error(
        `Port ${port} is already in use; the split runner will not reuse another service.`
      );
    } finally {
      if (listener.listening) await new Promise((done) => listener.close(done));
    }
  }
  const env = isolatedEnvironment();
  const running = new Map();
  const base = (role) => `http://127.0.0.1:${settings.ports[role]}`;
  const executable = (role) => {
    const python = resolve(
      paths[role],
      process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python'
    );
    if (!existsSync(python))
      throw new Error(
        `Install the ${role} dependencies first: uv sync --locked --extra dev in ${paths[role]}`
      );
    return python;
  };
  const launch = (role, operation) =>
    startProcess(
      executable(role),
      [resolve(root, 'scripts/local-service.py'), role, settings.file, operation],
      {
        cwd: paths[role],
        env: {
          ...env,
          CARDS_DEV_WEB_ORIGINS: JSON.stringify(web ? Object.values(webPorts).map(port => `http://localhost:${port}`) : []),
          CARDS_DEV_GOLF: golf ? '1' : '0',
        },
        label: role,
        echo,
      }
    );
  async function start(role) {
    const child = launch(role, 'serve');
    running.set(role, child);
    await waitForService(
      base(role),
      role === 'accounts' ? 'cards-accounts' : role + '-game',
      child
    );
  }
  async function startGateway() {
    let child;
    if (gateway === 'nginx') {
      await mkdir(resolve(settings.directory, 'logs'), { recursive: true });
      await mkdir(resolve(settings.directory, 'temp'), { recursive: true });
      const prefix = settings.directory.replaceAll('\\', '/') + '/';
      const quote = (value) => resolve(value).replaceAll('\\', '/');
      let proxy = await readFile(resolve(root, 'deploy/split/proxy.conf'), 'utf8');
      for (const role of roles)
        proxy = proxy.replaceAll(
          role + ':' + (role === 'golf' ? 5003 : role === 'euchre' ? 5002 : 5001),
          '127.0.0.1:' + settings.ports[role]
        );
      proxy = proxy
        .replaceAll(
          '/etc/nginx/cards-api-proxy.conf',
          quote(resolve(root, 'deploy/api-proxy.conf'))
        )
        .replaceAll(
          '/etc/nginx/cards-socket-proxy.conf',
          quote(resolve(root, 'deploy/socket-proxy.conf'))
        );
      // Quotes are needed for native paths containing spaces.
      proxy = proxy.replace(/include (.+);/g, (_, path) => `include "${path}";`);
      await writeFile(resolve(settings.directory, 'proxy.conf'), proxy);
      await writeFile(
        resolve(settings.directory, 'nginx.conf'),
        `daemon off;\nmaster_process off;\npid "${prefix}nginx.pid";\nerror_log "${prefix}nginx-error.log";\nevents {}\nhttp { access_log off; resolver 127.0.0.1; map $http_upgrade $cards_connection { default upgrade; '' close; } server { listen 127.0.0.1:${
          settings.ports.gateway
        }; root "${quote(
          resolve(root, 'public')
        )}"; include "${prefix}proxy.conf"; location / { try_files $uri $uri/ =404; } } }\n`
      );
      child = startProcess(process.env.NGINX_BIN || 'nginx', ['-p', prefix, '-c', 'nginx.conf'], {
        cwd: settings.directory,
        env,
        label: 'split nginx',
        echo,
      });
    } else if (gateway === 'node')
      child = startProcess(process.execPath, [resolve(root, 'scripts/serve.mjs')], {
        cwd: root,
        env: {
          ...env,
          PORT: String(settings.ports.gateway),
          CARDS_API_TARGET: base('accounts'),
          HEARTS_API_TARGET: base('hearts'),
          EUCHRE_API_TARGET: base('euchre'),
          ...(golf ? { GOLF_API_TARGET: base('golf') } : {}),
          ...(web ? Object.fromEntries(Object.entries(webPorts).map(([role, port]) => [role.toUpperCase() + '_LOCAL_URL', `http://localhost:${port}/`])) : {}),
          CARDS_DISABLE_LEGACY_SOCKET: '1',
          CARDS_LOCAL_OUTBOX: resolve(settings.directory, 'outbox'),
        },
        label: 'gateway',
        echo,
      });
    else throw new Error('Unknown local gateway');
    running.set('gateway', child);
    await waitForService(base('gateway') + '/api', 'cards-accounts', child);
  }
  const stack = {
    settings,
    running,
    base,
    webBase: (role) => `http://127.0.0.1:${webPorts[role]}`,
    identity: async (role) => running.get(role)?.child.pid,
    health: async (role) => (await fetch(base(role) + '/health')).json(),
    async restart(role) {
      if (!['gateway', ...roles].includes(role)) throw new Error('Unknown component');
      await running.get(role)?.close();
      if (role === 'gateway') await startGateway();
      else await start(role);
    },
    async close() {
      for (const child of [...running.values()].reverse()) await child.close();
      running.clear();
    },
    logs: () => [...running].map(([role, child]) => role + ': ' + child.logs()).join('\n'),
    async mail() {
      const { readdir } = await import('node:fs/promises');
      const outbox = resolve(settings.directory, 'outbox');
      return Promise.all(
        (await readdir(outbox))
          .filter((name) => name.endsWith('.json'))
          .sort()
          .map(async (name) => JSON.parse(await readFile(resolve(outbox, name), 'utf8')))
      );
    },
  };
  onCreated?.(stack);
  try {
    for (const role of roles) {
      signal?.throwIfAborted();
      const job = launch(role, 'migrate');
      running.set(role + '-migrate', job);
      await job.success();
      running.delete(role + '-migrate');
    }
    for (const role of roles) {
      signal?.throwIfAborted();
      await start(role);
    }
    signal?.throwIfAborted();
    await startGateway();
    if (web) {
      for (const role of ['hearts', 'euchre', ...(webPorts.golf ? ['golf'] : [])]) {
        signal?.throwIfAborted();
        const cwd = role === 'golf' ? resolve(root, '../golf/web') : resolve(paths[role], '../web');
        const child = startProcess(
          process.execPath,
          [
            resolve(cwd, 'node_modules/vite/bin/vite.js'),
            '--host',
            '127.0.0.1',
            '--port',
            String(webPorts[role]),
            '--strictPort',
          ],
          {
            cwd,
            env: {
              ...env,
              VITE_SHARED_ACCOUNTS: 'true',
              VITE_API_URL: '/api',
              VITE_BASE_PATH: '/',
              VITE_ACCOUNT_API_URL: '/api/account',
              CARDS_API_TARGET: base('accounts'),
              ACCOUNT_PROXY_TARGET: base('accounts'),
              HEARTS_API_TARGET: base('hearts'),
              EUCHRE_API_TARGET: base('euchre'),
              ...(golf ? { GOLF_API_TARGET: base('golf') } : {}),
              ...(role === 'golf' ? { VITE_CARDS_HOME_URL: base('gateway').replace('127.0.0.1', 'localhost') + '/' } : {}),
            },
            label: role + '-web',
            echo,
          }
        );
        running.set(role + '-web', child);
        const deadline = Date.now() + 30000;
        let ready = false;
        while (Date.now() < deadline) {
          signal?.throwIfAborted();
          if (child.child.exitCode !== null) throw new Error(role + ' web failed: ' + child.logs());
          try {
            const response = await fetch(stack.webBase(role) + '/api/account/session', {
              signal: AbortSignal.timeout(1000),
            });
            if (response.ok && (await response.json()).csrf_token) {
              ready = true;
              break;
            }
          } catch {}
          await new Promise((done) => setTimeout(done, 100));
        }
        if (!ready) throw new Error(role + ' web was not ready: ' + child.logs());
      }
    }
    return stack;
  } catch (error) {
    await stack.close();
    throw error;
  }
}
