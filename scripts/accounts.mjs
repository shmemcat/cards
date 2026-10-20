import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const api = process.env.HEARTS_API_PATH || resolve(root, '../hearts/api');
const python = process.env.HEARTS_PYTHON || resolve(api, process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python');
if (!existsSync(python)) throw new Error('Install the Hearts API dependencies first, or set HEARTS_PYTHON to its Python executable.');
const child = spawn(python, [resolve(root, 'scripts/account-dev.py')], { stdio: 'inherit', env: process.env, windowsHide: true });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code || 0; });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
