import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localMail } from './local-mail.mjs';
import { apiDestination as routeApi } from './api-destination.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const built = process.argv.includes('--dist');
const root = resolve(projectRoot, built ? 'dist' : 'public');
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
const localGames = !built && process.env.NODE_ENV !== 'production';
const accountApi = new URL(process.env.CARDS_API_TARGET || 'http://127.0.0.1:5000/');
if (!['http:', 'https:'].includes(accountApi.protocol)) throw new Error('CARDS_API_TARGET must use HTTP or HTTPS.');
const apiTargets = {
  accounts: accountApi,
  hearts: new URL(process.env.HEARTS_API_TARGET || accountApi),
  euchre: new URL(process.env.EUCHRE_API_TARGET || accountApi),
  legacy: process.env.CARDS_DISABLE_LEGACY_SOCKET === '1' ? null : new URL(process.env.CARDS_LEGACY_API_TARGET || accountApi),
};
for (const target of Object.values(apiTargets)) {
  if (target && !['http:', 'https:'].includes(target.protocol)) throw new Error('API targets must use HTTP or HTTPS.');
}
const targets = {
  hearts: new URL(process.env.HEARTS_LOCAL_URL || 'http://localhost:3001/'),
  euchre: new URL(process.env.EUCHRE_LOCAL_URL || 'http://localhost:3002/')
};
for (const target of Object.values(targets)) {
  if (!['http:', 'https:'].includes(target.protocol)) throw new Error('Game URLs must use HTTP or HTTPS.');
}
const types = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8'
};

// Route game aliases before /api/ and before local game-page redirects.
function apiDestination(incoming) {
  return routeApi(incoming, apiTargets);
}

const server = createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Cache-Control', 'no-store');
  let incoming;
  try { incoming = new URL(req.url, 'http://localhost'); }
  catch { res.writeHead(400).end('Bad request'); return; }
  try {
    let path = incoming.pathname;
    for (let pass = 0; pass < 4; pass++) {
      if (/(^|\/)_internal(\/|$)/.test(path)) { res.writeHead(404).end('Not found'); return; }
      const decoded = decodeURIComponent(path);
      if (decoded === path) break;
      path = decoded;
    }
  } catch { res.writeHead(404).end('Not found'); return; }
  const destination = apiDestination(incoming);
  if (destination?.retired) {
    res.writeHead(426, { 'Content-Type': 'application/json' }).end(JSON.stringify({ code: 'CLIENT_RELOAD_REQUIRED', error: 'Please reload to reconnect.' }));
    return;
  }
  if (destination) {
    const headers = { ...req.headers, host: destination.host };
    delete headers.connection;
    const timeout = destination.pathname.endsWith('/socket.io/') ? 120000 : 15000;
    const upstream = (destination.protocol === 'https:' ? httpsRequest : httpRequest)(destination, { method: req.method, headers, timeout }, response => {
      const responseHeaders = { ...response.headers, 'cache-control': 'no-store' };
      delete responseHeaders.connection;
      res.writeHead(response.statusCode, responseHeaders);
      response.pipe(res);
    });
    upstream.on('timeout', () => upstream.destroy());
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(503, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'The service is unavailable. Please try again.' }));
      else res.destroy();
    });
    req.on('aborted', () => upstream.destroy());
    req.pipe(upstream);
    return;
  }
  if (!['GET', 'HEAD'].includes(req.method)) {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end('Method not allowed');
    return;
  }
  try {
    const url = new URL(req.url, 'http://localhost');
    if (localGames && req.headers.host?.startsWith('127.0.0.1:')) {
      res.writeHead(308, { Location: `http://localhost:${port}${url.pathname}${url.search}` }).end();
      return;
    }
    if (localGames && url.pathname === '/__dev/mail/') {
      await localMail(req, res, process.env.CARDS_LOCAL_OUTBOX || resolve(projectRoot, '.local/outbox'));
      return;
    }
    if (['/verify-email', '/reset-password'].includes(url.pathname.replace(/\/$/, ''))) {
      const query = new URLSearchParams(url.search);
      query.set('view', url.pathname.startsWith('/verify') ? 'verify' : 'reset');
      res.writeHead(302, { Location: '/user/?' + query.toString(), 'Referrer-Policy': 'no-referrer' }).end();
      return;
    }
    const game = /^\/(hearts|euchre)(?:\/(.*))?$/.exec(url.pathname);
    if (localGames && game) {
      const destination = new URL(targets[game[1]]);
      destination.pathname = destination.pathname.replace(/\/?$/, '/') + (game[2] || '');
      destination.search = url.search;
      res.writeHead(302, { Location: destination.href }).end();
      return;
    }
    const pathname = decodeURIComponent(url.pathname);
    if (pathname === '/user') {
      res.writeHead(308, { Location: '/user/' + url.search }).end();
      return;
    }
    const file = resolve(root, '.' + (pathname.endsWith('/') ? pathname + 'index.html' : pathname));
    if (!file.startsWith(root + sep)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    const info = await stat(file);
    if (!info.isFile()) {
      res.writeHead(404).end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Content-Length': info.size });
    if (req.method === 'HEAD') res.end();
    else createReadStream(file).on('error', () => res.destroy()).pipe(res);
  } catch (error) {
    res.writeHead(error instanceof URIError ? 400 : 404).end(error instanceof URIError ? 'Bad request' : 'Not found');
  }
});

server.on('upgrade', (req, client, head) => {
  let incoming;
  try { incoming = new URL(req.url, 'http://localhost'); }
  catch { client.destroy(); return; }
  if (!/^\/(?:hearts\/|euchre\/)?socket\.io\/?$/.test(incoming.pathname)) {
    client.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    return;
  }
  const destination = apiDestination(incoming);
  if (destination?.retired) {
    client.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\n');
    return;
  }
  const upstream = (destination.protocol === 'https:' ? httpsRequest : httpRequest)(destination, {
    headers: { ...req.headers, host: destination.host }, timeout: 15000,
  });
  upstream.on('upgrade', (response, connection, upstreamHead) => {
    connection.setTimeout(0);
    client.write('HTTP/1.1 101 Switching Protocols\r\n' + response.rawHeaders.reduce(
      (lines, value, index, headers) => index % 2 ? lines : lines + `${value}: ${headers[index + 1]}\r\n`, ''
    ) + '\r\n');
    if (head.length) connection.write(head);
    if (upstreamHead.length) client.write(upstreamHead);
    client.pipe(connection).pipe(client);
    connection.on('error', () => client.destroy());
    client.on('error', () => connection.destroy());
    client.on('close', () => connection.destroy());
    connection.on('close', () => client.destroy());
  });
  upstream.on('response', response => {
    response.resume();
    client.end(`HTTP/1.1 ${response.statusCode} Service Unavailable\r\nConnection: close\r\n\r\n`);
  });
  upstream.on('timeout', () => upstream.destroy());
  upstream.on('error', () => client.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'));
  client.on('close', () => upstream.destroy());
  client.on('error', () => upstream.destroy());
  upstream.end();
});

server.listen(port, host, () => console.log(`Cards preview: http://${host}:${port}/`));
