import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localMail } from './local-mail.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const built = process.argv.includes('--dist');
const root = resolve(projectRoot, built ? 'dist' : 'public');
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
const localGames = !built && process.env.NODE_ENV !== 'production';
const accountApi = new URL(process.env.CARDS_API_TARGET || 'http://127.0.0.1:5000/');
if (!['http:', 'https:'].includes(accountApi.protocol)) throw new Error('CARDS_API_TARGET must use HTTP or HTTPS.');
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

createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Cache-Control', 'no-store');
  let incoming;
  try { incoming = new URL(req.url, 'http://localhost'); }
  catch { res.writeHead(400).end('Bad request'); return; }
  if (incoming.pathname.startsWith('/api/')) {
    const destination = new URL(accountApi);
    destination.pathname = accountApi.pathname.replace(/\/$/, '') + incoming.pathname.slice(4);
    destination.search = incoming.search;
    const headers = { ...req.headers, host: destination.host };
    delete headers.connection;
    const upstream = (destination.protocol === 'https:' ? httpsRequest : httpRequest)(destination, { method: req.method, headers, timeout: 15000 }, response => {
      const responseHeaders = { ...response.headers, 'cache-control': 'no-store' };
      delete responseHeaders.connection;
      res.writeHead(response.statusCode, responseHeaders);
      response.pipe(res);
    });
    upstream.on('timeout', () => upstream.destroy());
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(503, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Your account service is unavailable. Please try again.' }));
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
      await localMail(req, res, resolve(projectRoot, '.local/outbox'));
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
}).listen(port, host, () => console.log(`Cards preview: http://${host}:${port}/`));
