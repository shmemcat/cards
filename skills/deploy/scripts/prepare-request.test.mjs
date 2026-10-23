import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareRequest } from './prepare-request.mjs';
const status = { generation: 'a'.repeat(64), pending: false };
const record = { version: 1, component: 'hearts-web', image: `ghcr.io/shmemcat/hearts-cards-web@sha256:${'b'.repeat(64)}`, sourceRevision: 'c'.repeat(40) };
test('preserves published records and the exact host generation', () => {
  assert.deepEqual(prepareRequest('hearts', status, [record]), { version: 1, repo: 'hearts', expectedGeneration: status.generation, releases: [record] });
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
