import { request as httpRequest } from 'node:http';

import { BootFailedError, createRuntime, type BootReport, type Runtime } from '@murmur/node';
import type { HttpServer } from '@murmur/node/capabilities';
import type { Envelope } from 'murmur';

import { fixture } from '../helpers.ts';

export const ADA = { authorization: 'Bearer ada' };
export const ROOT = { authorization: 'Bearer root' };
export const JSON_TYPE = { 'content-type': 'application/json' };

export interface WebApp extends AsyncDisposable {
  readonly runtime: Runtime;
  readonly url: string;
  readonly tapped: Envelope[];
  inTrace(response: Response): Envelope[];
}

const ENV = { MURMUR_LOG_LEVEL: 'error', MURMUR__AUTH__PER_MINUTE: '100000' };

export async function bootWeb(policy: Parameters<typeof createRuntime>[0]['policy'] = {}): Promise<WebApp> {
  const tapped: Envelope[] = [];

  const runtime = await createRuntime({
    root: fixture('v2/web'),
    env: ENV,
    signals: false,
    mode: 'dev',
    policy,
    tap: (envelope) => tapped.push(envelope),
  });

  await runtime.start();
  const server = runtime.capabilities.get('web') as HttpServer;

  return {
    runtime,
    url: server.url,
    tapped,
    inTrace: (response) => tapped.filter((e) => e.traceId === response.headers.get('x-murmur-trace')),
    [Symbol.asyncDispose]: () => runtime.stop('test'),
  };
}

export async function bootFailure(name: string): Promise<BootReport> {
  const error: unknown = await createRuntime({ root: fixture(name), env: ENV, signals: false }).then(
    async (runtime) => {
      await runtime.stop('unexpected boot');

      return undefined;
    },
    (caught: unknown) => caught,
  );

  if (!(error instanceof BootFailedError)) {
    throw new Error(`expected BootFailedError, got ${String(error)}`);
  }

  return error.report;
}

export function sysPayloads(envelopes: readonly Envelope[], name: string): Record<string, unknown>[] {
  return envelopes.filter((e) => e.name === `$sys.${name}`).map((e) => e.payload as Record<string, unknown>);
}

export function getWithBody(
  url: string,
  headers: Record<string, string>,
  body: string,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      url,
      { method: 'GET', headers: { ...headers, 'content-length': Buffer.byteLength(body) } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}
