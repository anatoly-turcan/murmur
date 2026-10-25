import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { test } from 'node:test';

import { createRuntime, type Runtime } from '@murmur/node';
import { http, type HttpServer } from '@murmur/node/capabilities';
import { createTestRuntime, testPiece } from '@murmur/node/testing';
import type { AnyBinding, Envelope, IngressTarget } from 'murmur';

import { errorSettings } from '../../src/capabilities/http/errors.ts';
import { handleHttp, type HttpHost } from '../../src/capabilities/http/pipeline.ts';
import { createRouter } from '../../src/capabilities/http/router.ts';
import { fakeLog } from '../../src/testing/index.ts';
import { Needy } from '../fixtures/v2/pilot/pieces/needy/piece.ts';
import { fixture } from '../helpers.ts';

interface Booted extends AsyncDisposable {
  readonly runtime: Runtime;
  readonly logs: () => string[];
}

async function heldPort(): Promise<{ readonly port: number } & AsyncDisposable> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as { port: number };

  return {
    port,
    [Symbol.asyncDispose]: async () => {
      server.close();
      await once(server, 'close');
    },
  };
}

async function boot(env: Record<string, string> = {}, name?: string): Promise<Booted> {
  const tapped: Envelope[] = [];

  const runtime = await createRuntime({
    root: fixture('v2/pilot'),
    env: { MURMUR_LOG_LEVEL: 'info', ...env },
    signals: false,
    mode: 'prod',
    tap: (envelope) => tapped.push(envelope),
    ...(name === undefined ? {} : { process: name }),
  });

  await runtime.start();

  return {
    runtime,
    logs: () =>
      tapped.filter((e) => e.name === '$sys.log').map((e) => String(Reflect.get(Object(e.payload), 'msg'))),
    [Symbol.asyncDispose]: () => runtime.stop('test'),
  };
}

function urlOf(runtime: Runtime): string {
  return (runtime.capabilities.get('web') as HttpServer).url;
}

// The test holds the web port itself: a runtime that tried to listen would fail its boot with EADDRINUSE.
test('a process with no piece that serves through web leaves the http capability off', async () => {
  await using held = await heldPort();
  await using app = await boot({ MURMUR__CAP_WEB__PORT: String(held.port) }, 'domain');

  assert.deepEqual(
    app.runtime.pieces.map((p) => p.name),
    ['domain'],
  );
  assert.equal(app.runtime.capabilities.has('web'), false);
  assert.ok(
    app.logs().some((line) => /web not started: no loaded piece serves through it/.test(line)),
    app.logs().join('\n'),
  );
});

test('enabled: false keeps an ingress capability off even when pieces serve through it', async () => {
  await using held = await heldPort();

  await using app = await boot(
    {
      MURMUR__CAP_WEB__PORT: String(held.port),
      MURMUR__CAP_WEB__ENABLED: 'false',
    },
    'edge-health',
  );

  assert.equal(app.runtime.capabilities.has('web'), false);
  assert.ok(
    app.logs().some((line) => /web not started: enabled is false/.test(line)),
    app.logs().join('\n'),
  );
});

test('a piece that serves GET /healthz answers it instead of the built-in', async () => {
  await using app = await boot({}, 'health');
  const response = await fetch(`${urlOf(app.runtime)}/healthz`);

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { from: 'health piece' });
});

test('enabled: false on an ingress capability a piece needs fails boot with the reason', async () => {
  await assert.rejects(
    boot({ MURMUR__CAP_WEB__ENABLED: 'false' }, 'needy'),
    /needs\.web: capability web is not started \(enabled is false\)/,
  );
});

test('a wildcard route that matches /healthz leaves the built-in answer', async () => {
  await using app = await boot({}, 'catchall');
  const health = await fetch(`${urlOf(app.runtime)}/healthz`);
  const page = await fetch(`${urlOf(app.runtime)}/about`);
  assert.deepEqual(await health.json(), { ok: true });
  assert.deepEqual(await page.json(), { from: 'catchall' });
});

test('without a /healthz route the built-in answer stays', async () => {
  await using app = await boot({}, 'edge');
  const response = await fetch(`${urlOf(app.runtime)}/healthz`);
  const head = await fetch(`${urlOf(app.runtime)}/healthz`, { method: 'HEAD' });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(head.status, 200);
});

test('req.peer is the socket address and req.ip ignores X-Forwarded-For without trustProxy', async () => {
  await using app = await boot({}, 'edge');

  const response = await fetch(`${urlOf(app.runtime)}/whoami`, {
    headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' },
  });

  assert.deepEqual(await response.json(), { peer: '127.0.0.1', ip: '127.0.0.1' });
});

test('with trustProxy req.ip is the first X-Forwarded-For entry, else the peer', async () => {
  await using app = await boot({ MURMUR__CAP_WEB__TRUST_PROXY: 'true' }, 'edge');

  const forwarded = await fetch(`${urlOf(app.runtime)}/whoami`, {
    headers: { 'x-forwarded-for': ' 203.0.113.7 , 10.0.0.1' },
  });

  const direct = await fetch(`${urlOf(app.runtime)}/whoami`);
  assert.deepEqual(await forwarded.json(), { peer: '127.0.0.1', ip: '203.0.113.7' });
  assert.deepEqual(await direct.json(), { peer: '127.0.0.1', ip: '127.0.0.1' });
});

function problemEnvelope(failure: { code: string }, traceId: string): { problem: string; traceId: string } {
  return { problem: failure.code, traceId };
}

function targetOf(binding: AnyBinding): IngressTarget {
  return {
    piece: 'p',
    serve: { binding, method: undefined, get: undefined, contract: undefined },
    instance: () => ({}),
  };
}

test('404 and 405 use the error envelope of the token, 404 even when the router has no routes', async () => {
  const settings = { guards: [], errors: errorSettings({ envelope: problemEnvelope }), maxBodyBytes: 1024 };
  const web = http({ errors: { envelope: problemEnvelope } });
  const host: HttpHost = {
    mode: 'prod',
    log: fakeLog(),
    freshTraceId: () => 'trace-1',
    invoke: () => Promise.reject(new Error('no route expected')),
    request: () => Promise.reject(new Error('no request expected')),
  };
  const missing = await handleHttp(new Request('http://app/nope'), createRouter([], settings), host);
  const oneGet = createRouter([targetOf(web.get('/thing'))], settings);
  const wrongMethod = await handleHttp(new Request('http://app/thing', { method: 'POST' }), oneGet, host);

  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { problem: 'not_found', traceId: 'trace-1' });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('allow'), 'GET, HEAD, OPTIONS');
  assert.deepEqual(await wrongMethod.json(), { problem: 'http_405', traceId: 'trace-1' });
});

test('testPiece answers 404 with the envelope of the token a piece with no route needs', async () => {
  await using t = await testPiece(Needy, { needs: { web: {} as HttpServer } });
  const response = await t.fetch(new Request('http://app/nope'));
  const body = (await response.json()) as Record<string, unknown>;

  assert.equal(response.status, 404);
  assert.equal(body['problem'], 'not_found');
});

test('createTestRuntime answers 404 with the envelope of the token a piece with no route needs', async () => {
  await using t = await createTestRuntime({ pieces: [Needy], capabilities: { web: {} } });
  const response = await t.fetch(new Request('http://app/nope'));
  const body = (await response.json()) as Record<string, unknown>;

  assert.equal(response.status, 404);
  assert.equal(body['problem'], 'not_found');
});

test('a 404 from a running server carries the configured envelope', async () => {
  await using app = await boot({}, 'edge');
  const response = await fetch(`${urlOf(app.runtime)}/nope`);
  const body = (await response.json()) as Record<string, unknown>;

  assert.equal(response.status, 404);
  assert.equal(body['problem'], 'not_found');
});
