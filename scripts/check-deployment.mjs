// Read-only smoke checks against a running combined Cards gateway.
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

const origin = new URL(process.argv[2] || 'http://localhost:3096');
async function get(path, headers = {}) {
  // Fetch implementations can discard Host overrides; use the HTTP client for
  // virtual-host checks against a local gateway before public DNS is changed.
  if (headers.Host) {
    return new Promise((resolve, reject) => {
      const request = (origin.protocol === 'https:' ? httpsRequest : httpRequest)(
        new URL(path, origin), { headers }, response => {
          const chunks = [];
          response.on('data', chunk => chunks.push(chunk));
          response.on('end', () => resolve(new Response(Buffer.concat(chunks), {
            status: response.statusCode, headers: response.headers,
          })));
        });
      request.on('error', reject);
      request.end();
    });
  }
  return fetch(new URL(path, origin), { redirect: 'manual', headers });
}
for (const path of ['/', '/user/', '/hearts/', '/hearts/about', '/euchre/', '/euchre/about']) {
  const response = await get(path);
  assert.equal(response.status, 200, path);
  assert.match(response.headers.get('content-type'), /text\/html/, path);
  const html = await response.text();
  for (const [, asset] of html.matchAll(/(?:src|href)="([^"#]+\.(?:js|css))"/g)) {
    const resource = await get(new URL(asset, new URL(path, origin)).pathname);
    assert.equal(resource.status, 200, asset);
    assert.doesNotMatch(resource.headers.get('content-type'), /text\/html/, asset);
  }
}
for (const path of ['/__dev/mail/', '/.env', '/hearts/assets/missing.js', '/euchre/assets/missing.css']) {
  assert.equal((await get(path)).status, 404, path);
}
for (const [path, host, destination] of [
  ['/game/lobby/ABC123?invite=1', 'hearts.shmem.dev', 'https://cards.shmem.dev/hearts/game/lobby/ABC123?invite=1'],
  ['/game?resume=1', 'euchre.shmem.dev', 'https://cards.shmem.dev/euchre/game?resume=1'],
  ['/verify-email?token=smoke-only', 'hearts.shmem.dev', 'https://cards.shmem.dev/user/?view=verify&token=smoke-only'],
  ['/reset-password?token=smoke-only', 'hearts.shmem.dev', 'https://cards.shmem.dev/user/?view=reset&token=smoke-only'],
]) {
  const response = await get(path, { Host: host });
  assert.ok([302, 308].includes(response.status), path);
  assert.equal(response.headers.get('location'), destination, path);
}
assert.equal((await get('/api/health')).status, 200);
const session = await get('/api/account/session');
assert.equal(session.status, 200);
assert.equal(session.headers.get('cache-control'), 'no-store');
assert.equal((await session.json()).user, null);
const transport = await get('/socket.io/?EIO=4&transport=polling');
assert.equal(transport.status, 200);
assert.match(await transport.text(), /^0\{"sid":/);
console.log('Combined routes, assets, redirects, account API, and Socket.IO checks passed.');
