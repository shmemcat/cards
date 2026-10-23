import assert from 'node:assert/strict';

// Check the actual published bundles served through the production-shaped gateway.
export async function verifyFrontendAssets(base) {
  const origin = new URL(base);
  assert(origin.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(origin.hostname));
  for (const game of ['hearts', 'euchre']) {
    const response = await fetch(base + '/' + game + '/');
    assert.equal(response.status, 200);
    const html = await response.text();
    const script = html.match(/<script[^>]+src="([^"]+)"/)?.[1];
    assert(script?.startsWith('/' + game + '/assets/'), 'Frontend asset base is incorrect');
    const asset = await fetch(base + script);
    assert.equal(asset.status, 200);
    assert(asset.headers.get('content-type')?.includes('javascript'));
    assert(
      (await asset.text()).includes('/' + game + '/socket.io'),
      'Published frontend uses the wrong game transport'
    );
    assert.equal(
      (await fetch(base + '/' + game + '/assets/missing-rehearsal-file.js')).status,
      404
    );
    assert.equal((await fetch(base + '/' + game, { redirect: 'manual' })).status, 308);
  }
  return {
    publishedFrontendsServed: 2,
    separateSocketPaths: true,
    correctAssetBases: true,
    missingAssets404: true,
  };
}
