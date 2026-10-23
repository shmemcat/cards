import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startProcess } from './service-process.mjs';

test('tool warnings remain diagnostic without corrupting captured JSON', async () => {
  const process = startProcess(globalThis.process.execPath, ['-e',
    'process.stderr.write("tool warning\\n"); process.stdout.write(JSON.stringify({ready:true}));',
  ]);
  await process.success();
  assert.deepEqual(JSON.parse(process.stdout()), { ready: true });
  assert.match(process.logs(), /tool warning/);
});

test('failed tools retain stderr in their error', async () => {
  const process = startProcess(globalThis.process.execPath, ['-e',
    'process.stderr.write("migration refused"); process.exitCode=1;',
  ]);
  await assert.rejects(process.success(), /migration refused/);
});

test('binary backup streams are preserved without entering diagnostic capture', async () => {
  const process = startProcess(globalThis.process.execPath, ['-e',
    'process.stdin.pipe(process.stdout);',
  ], { stdin: 'pipe', captureStdout: false });
  const chunks = [];
  process.child.stdout.on('data', chunk => chunks.push(chunk));
  const bytes = Buffer.from([0, 255, 128, 10, 13, 0, 65]);
  process.child.stdin.end(bytes);
  await process.success();
  assert.deepEqual(Buffer.concat(chunks), bytes);
  assert.equal(process.stdout(), '');
  assert.equal(process.logs(), '');
});
