import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareRequest } from './prepare-request.mjs';
const status = { generation: 'a'.repeat(64), pending: false };
const record = { version: 1, component: 'hearts-web', image: `ghcr.io/shmemcat/hearts-cards-web@sha256:${'b'.repeat(64)}`, sourceRevision: 'c'.repeat(40) };
test('preserves published records and the exact host generation', () => {
  assert.deepEqual(prepareRequest('hearts', status, [record]), { version: 1, repo: 'hearts', expectedGeneration: status.generation, releases: [record] });
});

test('Golf promotions keep their repository boundary', () => {
  const golf = { ...record, component: 'golf-web', image: `ghcr.io/shmemcat/golf-web@sha256:${'b'.repeat(64)}` };
  assert.equal(prepareRequest('golf', status, [golf]).repo, 'golf');
  assert.throws(() => prepareRequest('cards', status, [golf]));
  assert.throws(() => prepareRequest('golf', status, [record]));
});

test('Hand and Foot aliases produce host requests for either or both components', () => {
  const game = { ...record, component: 'handandfoot-game', image: `ghcr.io/shmemcat/handandfoot-game-api@sha256:${'b'.repeat(64)}` };
  const web = { ...record, component: 'handandfoot-web', image: `ghcr.io/shmemcat/handandfoot-web@sha256:${'b'.repeat(64)}` };
  for (const repo of ['hand-and-foot', 'handandfoot', 'hand and foot']) {
    for (const releases of [[game], [web], [game, web]]) {
      assert.deepEqual(prepareRequest(repo, status, releases), {
        version: 1, repo: 'hand-and-foot', expectedGeneration: status.generation, releases,
      });
    }
  }
});

test('Hand and Foot promotions retain repository, recovery and immutable-source checks', () => {
  const game = { ...record, component: 'handandfoot-game', image: `ghcr.io/shmemcat/handandfoot-game-api@sha256:${'b'.repeat(64)}` };
  const web = { ...record, component: 'handandfoot-web', image: `ghcr.io/shmemcat/handandfoot-web@sha256:${'b'.repeat(64)}` };
  for (const repo of ['cards', 'hearts', 'euchre', 'golf']) {
    assert.throws(() => prepareRequest(repo, status, [game]));
    assert.throws(() => prepareRequest(repo, status, [web]));
    assert.throws(() => prepareRequest('hand-and-foot', status, [{ ...record, component: repo === 'cards' ? 'cards-accounts' : repo + '-game' }]));
  }
  assert.throws(() => prepareRequest('hand-and-foot', { ...status, pending: true }, [game, web]));
  assert.throws(() => prepareRequest('hand-and-foot', { ...status, generation: 'stale' }, [game]));
  assert.throws(() => prepareRequest('hand-and-foot', status, [web, web]));
  assert.throws(() => prepareRequest('hand-and-foot', status, []));
  assert.throws(() => prepareRequest('hand-and-foot', status, [{ ...game, image: 'ghcr.io/shmemcat/handandfoot-game-api:latest' }]));
  assert.throws(() => prepareRequest('hand-and-foot', status, [{ ...game, sourceRevision: 'short' }]));
});

test('refuses pending recovery, foreign components and duplicates', () => {
  assert.throws(() => prepareRequest('hearts', { ...status, pending: true }, [record]));
  assert.throws(() => prepareRequest('euchre', status, [record]));
  assert.throws(() => prepareRequest('hearts', status, [record, record]));
});
test('refuses moving tags and incomplete source revisions', () => {
  assert.throws(() => prepareRequest('hearts', status, [{ ...record, image: 'ghcr.io/shmemcat/hearts-cards-web:latest' }]));
  assert.throws(() => prepareRequest('hearts', status, [{ ...record, sourceRevision: 'short' }]));
});
