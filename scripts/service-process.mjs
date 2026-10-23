import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

export function startProcess(
  command,
  args,
  { cwd, env = process.env, label = command, echo = false, stdin = 'ignore', captureStdout = true } = {}
) {
  const child = spawn(command, args, {
    cwd,
    env,
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: [stdin, 'pipe', 'pipe'],
  });
  let output = '',
    stdout = '',
    failure;
  for (const stream of [captureStdout ? child.stdout : null, child.stderr].filter(Boolean))
    stream.on('data', (data) => {
      output = (output + data).slice(-16000);
      if (stream === child.stdout) stdout = (stdout + data).slice(-16000);
      if (echo) process.stdout.write(`[${label}] ${data}`);
    });
  child.on('error', (error) => {
    failure = error;
  });
  const completed = new Promise((resolve) => {
    child.once('error', () => resolve(-1));
    child.once('close', (code) => resolve(code));
  });
  return {
    child,
    completed,
    label,
    logs: () => output,
    stdout: () => stdout,
    async success() {
      const code = await completed;
      if (code !== 0) throw new Error(`${label} failed: ${failure?.message || output}`);
    },
    async close() {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
        await new Promise((resolve) => {
          killer.once('exit', resolve);
          killer.once('error', () => {
            child.kill();
            resolve();
          });
        });
      } else {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch (error) {
          if (error.code !== 'ESRCH') throw error;
        }
      }
      await completed;
    },
  };
}

export async function waitForService(url, component, process, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (
      process &&
      (!process.child.pid || process.child.exitCode !== null || process.child.signalCode !== null)
    )
      throw new Error(`${component} stopped: ${process.logs()}`);
    try {
      const health = await fetch(url + '/health', { signal: AbortSignal.timeout(800) });
      if (
        health.ok &&
        (await health.json()).component === component &&
        (await fetch(url + '/ready', { signal: AbortSignal.timeout(800) })).ok
      )
        return;
    } catch {}
    await delay(100);
  }
  throw new Error(`${component} was not ready: ${process?.logs() || url}`);
}
