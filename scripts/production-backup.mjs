import { pipeline } from 'node:stream/promises';
import { resolve, relative } from 'node:path';
import { access } from 'node:fs/promises';
import { startProcess } from './service-process.mjs';
import { root } from './split-stack.mjs';

export const productionDumpCommand = "sudo -n -u postgres env PGOPTIONS='-c default_transaction_read_only=on -c lock_timeout=5000' pg_dump --schema=hearts --format=custom --no-owner --no-acl shmemcity";

export function validateBackupHost(host) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(host)) throw new Error('Use an SSH host alias');
  return host;
}

export function validateRestoreArguments(args) {
  const allowed = new Set(['--pins', '--ssh-config', '--ssh-host']);
  for (let index = 0; index < args.length; index += 2) {
    if (!allowed.has(args[index]) || !args[index + 1] || args[index + 1].startsWith('--'))
      throw new Error('Use --pins FILE with optional --ssh-config FILE and --ssh-host ALIAS');
  }
}

export function backupConfigArgument(path) {
  // Windows OpenSSH's ProxyJump child mishandles absolute config paths with spaces.
  const argument = relative(root, resolve(path)).replaceAll('\\', '/');
  if (/\s/.test(argument)) throw new Error('Use an SSH config path without spaces relative to Cards');
  return argument;
}

export async function streamProductionRestore({ sshConfig, host = 'cards-box', args, env, signal }) {
  validateBackupHost(host);
  const config = resolve(sshConfig);
  await access(config);
  const configArgument = backupConfigArgument(config);
  signal?.throwIfAborted();
  const source = startProcess('ssh', ['-F', configArgument, host, productionDumpCommand], {
    cwd: root, env, label: 'read-only backup', captureStdout: false,
  });
  const target = startProcess('docker', args, {
    cwd: root, env, label: 'private restore', stdin: 'pipe', captureStdout: false,
  });
  const stop = () => { void source.close(); void target.close(); };
  const timeout = setTimeout(stop, 180000);
  signal?.addEventListener('abort', stop, { once: true });
  try {
    const [, sourceCode, targetCode] = await Promise.all([
      pipeline(source.child.stdout, target.child.stdin), source.completed, target.completed,
    ]);
    if (sourceCode !== 0 || targetCode !== 0) throw new Error('Backup or restore exited unsuccessfully');
  } catch (error) {
    const diagnostics = source.logs() + target.logs();
    const category = /permission denied|access is denied/i.test(diagnostics) ? 'access denied'
      : /could not translate host|could not resolve|name resolution/i.test(diagnostics) ? 'host resolution'
      : /unsupported version|version mismatch/i.test(diagnostics) ? 'backup version'
      : /must be owner|role .* does not exist/i.test(diagnostics) ? 'restored ownership'
      : /schema .* already exists|already exists/i.test(diagnostics) ? 'existing restore objects'
      : /input file is too short|not a valid archive/i.test(diagnostics) ? 'incomplete archive'
      : error.code || 'backup or restore command';
    throw new Error(`Read-only backup/isolated restore failed (${category}; ssh=${source.child.exitCode}, restore=${target.child.exitCode}); private output withheld.`);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', stop);
    await Promise.all([source.close(), target.close()]);
  }
}
