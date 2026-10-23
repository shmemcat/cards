import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validatePins, repositories } from './container-stack.mjs';

export function replacePin(pins, component, image) {
  validatePins(pins);
  if (!Object.hasOwn(repositories, component))
    throw new Error('Choose accounts, hearts, euchre, or gateway.');
  return validatePins({ ...pins, [component]: image });
}
async function main([input, component, image, output]) {
  if (!output || resolve(input) === resolve(output))
    throw new Error(
      'Use input.json component image@sha256:digest new-output.json; existing pins are preserved.'
    );
  const candidate = replacePin(
    JSON.parse(await readFile(resolve(input), 'utf8')),
    component,
    image
  );
  await writeFile(resolve(output), JSON.stringify(candidate, null, 2) + '\n', { flag: 'wx' });
  console.log(
    'Candidate pins saved. Rehearse this manifest before requesting a deployment change.'
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
