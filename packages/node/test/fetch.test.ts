import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { test } from 'node:test';

import { fetch } from '@murmur/node/capabilities';

import { runContext } from '../src/context.ts';

test('the fetch capability adds trace headers and aborts with the delivery', async () => {
  let headers: IncomingHttpHeaders = {};
  const server = createServer((req, res) => {
    headers = req.headers;

    if (req.url === '/slow') {
      return;
    }

    res.end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const capability = fetch();
  const instance = await capability.start({ config: { timeoutMs: 1_000 } } as never);
  const ctrl = new AbortController();
  const traceId = '80521f3a-91c2-4b62-8a16-f4a7d9e0c2ab';
  const run = { traceId, hop: 0, piece: 'p', signal: ctrl.signal, internal: false };
  const scoped = (url: string) => runContext.run(run, () => instance(url));

  try {
    assert.equal(await (await scoped(`${base}/fast`)).text(), 'ok');
    assert.equal(headers['x-murmur-trace'], traceId);
    assert.match(String(headers['traceparent']), /^00-80521f3a91c24b628a16f4a7d9e0c2ab-[0-9a-f]{16}-01$/);
    const slow = scoped(`${base}/slow`);
    ctrl.abort(new Error('delivery aborted'));
    await assert.rejects(slow, /delivery aborted/);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
