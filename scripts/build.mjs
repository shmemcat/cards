import { cp, mkdir } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(projectRoot, 'dist');
const sourceRoot = resolve(projectRoot, 'public');
await mkdir(output, { recursive: true });
await cp(sourceRoot, output, {
  recursive: true,
  filter: source => !relative(sourceRoot, source).split(sep).includes('.local')
});
console.log('Built Cards landing page in dist/');
