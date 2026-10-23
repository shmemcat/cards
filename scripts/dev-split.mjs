import { resolve } from 'node:path';
import { root, startNativeStack } from './split-stack.mjs';

let stack,
  stopping = false;
const controller = new AbortController();
async function close(code = 0) {
  if (stopping) return;
  stopping = true;
  controller.abort();
  await stack?.close();
  process.exitCode = code;
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void close());
try {
  stack = await startNativeStack({
    directory: resolve(root, '.local/split-dev'),
    ports: { gateway: 3000, accounts: 5100, hearts: 5101, euchre: 5102 },
    web: true,
    echo: true,
    signal: controller.signal,
    onCreated: (value) => {
      stack = value;
    },
  });
  if (stopping) await stack.close();
  else {
    console.log('Split Cards stack: http://localhost:3000/');
    console.log('Local inbox: http://localhost:3000/__dev/mail/');
    console.log('Separate test data: Cards/.local/split-dev/');
    for (const [role, service] of stack.running)
      service.completed.then(() => {
        if (!stopping) {
          console.error(`${role} stopped.`);
          void close(1);
        }
      });
  }
} catch (error) {
  if (!stopping) console.error(error.message);
  await close(1);
}
