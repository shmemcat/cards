import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
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
const stylesheet = await readFile(resolve(output, 'styles.css'));
const version = createHash('sha256').update(stylesheet).digest('hex').slice(0, 12);
const indexPath = resolve(output, 'index.html');
const html = await readFile(indexPath, 'utf8');
const versionedHtml = html.replace('href="/styles.css"', `href="/styles.css?v=${version}"`);
if (html === versionedHtml) throw new Error('The hub stylesheet link is missing.');
await writeFile(indexPath, versionedHtml);
console.log('Built Cards landing page in dist/');
