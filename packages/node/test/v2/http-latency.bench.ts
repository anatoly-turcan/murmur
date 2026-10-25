import { createRuntime, loadAppDefinition, type AppDefinition } from '@murmur/node';
import type { HttpServer } from '@murmur/node/capabilities';
import type { Transport } from 'murmur';

import { fixture } from '../helpers.ts';

interface AmqpModule {
  createAmqpTransport(options: { readonly url: string }): Promise<Transport>;
}

const ROUNDS = Number(process.argv[2] ?? 2000);
const WARMUP = 200;
const HEADERS = { authorization: 'Bearer ada' };

async function appFor(url: string | undefined): Promise<AppDefinition> {
  const app = await loadAppDefinition(fixture('v2/web'));
  if (url === undefined) {
    return app;
  }

  const amqp = (await import(
    new URL('../../../transport-amqp/src/index.ts', import.meta.url).href
  )) as AmqpModule;

  return { ...app, transport: () => amqp.createAmqpTransport({ url }) };
}

function percentile(sorted: readonly number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? Number.NaN;
}

async function timed(url: string): Promise<number> {
  const started = performance.now();
  const response = await fetch(url, { headers: HEADERS });
  await response.arrayBuffer();

  return performance.now() - started;
}

async function series(url: string, rounds: number, samples: number[] = []): Promise<number[]> {
  if (samples.length >= rounds) {
    return samples;
  }

  samples.push(await timed(url));

  return series(url, rounds, samples);
}

async function measure(label: string, amqpUrl: string | undefined): Promise<void> {
  await using runtime = await createRuntime({
    root: fixture('v2/web'),
    app: await appFor(amqpUrl),
    env: { MURMUR_LOG_LEVEL: 'error', MURMUR__AUTH__PER_MINUTE: '1000000' },
    signals: false,
    mode: 'prod',
  });

  await runtime.start();
  const server = runtime.capabilities.get('web') as HttpServer;

  const created = await fetch(`${server.url}/todos`, {
    method: 'POST',
    headers: { ...HEADERS, 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'bench' }),
  });

  const { id } = (await created.json()) as { id: string };
  const target = `${server.url}/todos/${id}`;
  await series(target, WARMUP);
  const sorted = (await series(target, ROUNDS)).toSorted((a, b) => a - b);
  const p50 = percentile(sorted, 50).toFixed(2);
  const p99 = percentile(sorted, 99).toFixed(2);

  console.log(
    `${label}: GET /todos/:id, 2 guards + 1 query, ${ROUNDS} sequential requests: p50 ${p50} ms, p99 ${p99} ms`,
  );
}

await measure('memory', undefined);

const amqpUrl = process.argv[3];
if (amqpUrl !== undefined) {
  await measure('amqp', amqpUrl);
}
