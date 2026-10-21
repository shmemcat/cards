import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

export async function localMail(req, res, outbox) {
  const address = req.socket.remoteAddress;
  let hostname;
  try { hostname = new URL(`http://${req.headers.host}`).hostname; } catch {}
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address) || !['localhost', '127.0.0.1', '[::1]'].includes(hostname)) {
    res.writeHead(404).end('Not found');
    return;
  }
  const files = await readdir(outbox, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const messages = await Promise.all(files.filter(file => file.isFile() && file.name.endsWith('.json')).sort((a, b) => b.name.localeCompare(a.name)).slice(0, 30).map(async file => {
    try {
      const source = await readFile(join(outbox, file.name), 'utf8');
      if (source.length > 131072) return '';
      const mail = JSON.parse(source);
      const url = new URL(mail.url);
      if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1'].includes(url.hostname) || url.pathname !== '/user/' || !['verify', 'reset'].includes(url.searchParams.get('view')) || !url.searchParams.get('token')) return '';
      const label = url.searchParams.get('view') === 'verify' ? 'Verify email' : 'Reset password';
      // Only show plain text and same-site account links, never the email's HTML.
      return `<article class="mail"><h2>${escape(mail.subject)}</h2><p>${escape(mail.to)}</p><a class="account-button" href="${escape(url.pathname + url.search)}"><span class="button-shine" aria-hidden="true"></span>${label}</a></article>`;
    } catch { return ''; }
  }));
  const html = `<!doctype html><html lang="en" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Local inbox · Cards</title><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="/styles.css"><script src="/theme.js"></script><style>main{width:min(100% - 40px,640px);margin:60px auto}h1{font-size:2.5rem;letter-spacing:3px}.mail{padding:24px 0;border-bottom:1px solid var(--muted);text-align:center}.mail h2{font-size:1.35rem;letter-spacing:.5px}.mail p{margin:10px 0 20px}.mail .account-button{margin:0 auto;text-decoration:none}.inbox-links{display:flex;justify-content:center;gap:24px;margin:24px 0}.inbox-note{text-align:center;opacity:.75}</style></head><body><main><h1>Local inbox</h1><p class="inbox-note">Verification and recovery emails for local accounts.</p><nav class="inbox-links" aria-label="Inbox navigation"><a class="account-text-link" href="/user/">Account</a><a class="account-text-link" href="/__dev/mail/">Refresh</a></nav>${messages.filter(Boolean).join('') || '<p class="inbox-note">No emails yet.</p>'}</main></body></html>`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Length': Buffer.byteLength(html), 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'" });
  res.end(req.method === 'HEAD' ? undefined : html);
}
