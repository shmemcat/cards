import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const components = {
  hearts: ['hearts-game', 'hearts-web'],
  euchre: ['euchre-game', 'euchre-web'],
  golf: ['golf-game', 'golf-web'],
  'hand-and-foot': ['handandfoot-game', 'handandfoot-web'],
  cards: ['cards-accounts', 'cards-gateway'],
};

export function prepareRequest(repo, status, releases) {
  if (repo === 'handandfoot' || repo === 'hand and foot') repo = 'hand-and-foot';
  if (!Object.hasOwn(components, repo)) throw new Error('Select hearts, euchre, golf, hand-and-foot or cards.');
  if (status.pending || !/^[0-9a-f]{64}$/.test(status.generation ?? ''))
    throw new Error('Read a fresh host status without pending recovery.');
  if (!Array.isArray(releases) || releases.length < 1 || releases.length > 2)
    throw new Error('Provide one or two published component records.');
  const seen = new Set();
  for (const record of releases) {
    if (!components[repo].includes(record.component) || seen.has(record.component))
      throw new Error('Records must be unique components of the selected repository.');
    if (record.version !== 1 || !/^ghcr\.io\/shmemcat\/[a-z-]+@sha256:[0-9a-f]{64}$/.test(record.image ?? '')
        || !/^[0-9a-f]{40}$/.test(record.sourceRevision ?? ''))
      throw new Error('A published immutable image and complete source revision are required.');
    seen.add(record.component);
  }
  return { version: 1, repo, expectedGeneration: status.generation, releases };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [repo, statusPath, ...paths] = process.argv.slice(2);
    const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
    console.log(JSON.stringify(prepareRequest(repo, read(statusPath), paths.map(read)), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
