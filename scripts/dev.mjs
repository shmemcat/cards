import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configuredApi = process.env.CARDS_API_TARGET;
const accountApi = new URL(configuredApi || 'http://127.0.0.1:5000/');
accountApi.pathname = accountApi.pathname.replace(/\/?$/, '/') + 'account/session';
const children = new Set();
let stopping = false;

async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  await Promise.all([...children].map(child => new Promise(resolveStop => {
    if (child.exitCode !== null || child.signalCode !== null) return resolveStop();
    child.once('exit', resolveStop);
    if (process.platform === 'win32') {
      // Stop only process trees launched by this runner, including Python and the watcher.
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      killer.once('error', () => { child.kill(); resolveStop(); });
      killer.once('exit', resolveStop);
    } else {
      child.kill('SIGTERM');
    }
  })));
  process.exitCode = code;
}

function launch(args, label) {
  const child = spawn(process.execPath, args, { cwd: root, env: process.env, stdio: 'inherit', windowsHide: true });
  children.add(child);
  child.once('error', error => {
    console.error(`${label}: ${error.message}`);
    children.delete(child);
    void stop(1);
  });
  child.once('exit', (code, signal) => {
    children.delete(child);
    if (!stopping) {
      console.error(`${label} stopped${signal ? ` (${signal})` : ''}.`);
      void stop(code || 1);
    }
  });
  return child;
}

async function accountReady() {
  let response;
  try {
    response = await fetch(accountApi, { signal: AbortSignal.timeout(1200) });
  } catch (error) {
    if (error.cause?.code === 'ECONNREFUSED') return false;
    throw new Error('Unable to reach the account API. Check CARDS_API_TARGET and whether its server is running.', { cause: error });
  }
  const data = await response.json().catch(() => null);
  if (!response.ok || typeof data?.csrf_token !== 'string') {
    throw new Error('The account API is running but shared accounts are unavailable. Check CARDS_PUBLIC_URL, or set CARDS_API_TARGET to the shared account service.');
  }
  return true;
}

process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());

try {
  if (await accountReady()) {
    console.log('Using the running shared account service.');
  } else {
    if (configuredApi) throw new Error('The configured account API is not running. Start it before launching the hub.');
    const account = launch([resolve(root, 'scripts/accounts.mjs')], 'Shared account service');
    let ready = false;
    for (let attempt = 0; attempt < 60 && !stopping; attempt++) {
      if (account.exitCode !== null) break;
      if (await accountReady()) { ready = true; break; }
      await setTimeout(250);
    }
    if (stopping) { /* A child failure or signal already stopped this run. */ }
    else if (!ready) throw new Error('The shared account service did not start. Check the API output above.');
  }
  if (!stopping) {
    launch(['--watch', resolve(root, 'scripts/serve.mjs')], 'Cards preview');
    console.log('Local verification and recovery emails: http://localhost:3000/__dev/mail/');
  }
} catch (error) {
  console.error(error.message);
  await stop(1);
}
