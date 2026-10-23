import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startContainerStack } from './container-stack.mjs';
import { verifySplitStack } from './verify-split-stack.mjs';

const build = process.argv.includes('--build');
const configOnly = process.argv.includes('--config-only');
const postgres = process.argv.includes('--postgres');
if (postgres && !build) throw new Error('The synthetic legacy rehearsal requires --build.');
const index = process.argv.indexOf('--pins');
const pins =
  index >= 0
    ? JSON.parse(await readFile(resolve(process.argv[index + 1]), 'utf8'))
    : {
        accounts: process.env.ACCOUNTS_IMAGE,
        hearts: process.env.HEARTS_IMAGE,
        euchre: process.env.EUCHRE_IMAGE,
        gateway: process.env.GATEWAY_IMAGE,
      };
let stack;
const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    controller.abort();
  });
try {
  stack = await startContainerStack({
    pins,
    build,
    configOnly,
    echo: !configOnly,
    signal: controller.signal,
    onCreated: (value) => {
      stack = value;
    },
  });
  if (configOnly) console.log('Isolated Compose configuration validated.');
  else {
    const postgresChecks = postgres
      ? await (await import('./verify-postgres.mjs')).verifyPostgres(stack)
      : undefined;
    const checks = await verifySplitStack(stack);
    const health = Object.fromEntries(
      await Promise.all(
        ['accounts', 'hearts', 'euchre'].map(async (role) => [role, await stack.health(role)])
      )
    );
    await writeFile(
      resolve(stack.directory, 'report.json'),
      JSON.stringify(
        { version: 1, pins: build ? null : pins, builtLocally: build, health, checks, postgres: postgresChecks },
        null,
        2
      ) + '\n'
    );
    console.log(JSON.stringify(checks));
  }
} finally {
  await stack?.close?.();
}
