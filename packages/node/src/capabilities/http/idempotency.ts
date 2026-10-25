import { IDEMPOTENCY_DEFAULTS, MurmurError, REQUEST_SCOPE_PATHS } from 'murmur';

import { current } from '../../context.ts';
import { canonicalJson, sha256 } from '../../lib/index.ts';
import type { HttpRoute, IdempotentOptions } from './binding.ts';
import type { IncomingBody } from './body.ts';
import type { Client } from './client.ts';
import { InputError, renderFailure, type IdempotencyRefusal } from './errors.ts';
import type { Claim, IdempotencyStore, StoredResponse } from './idempotency-store.ts';

export interface IdempotentCall {
  readonly route: HttpRoute;
  readonly url: URL;
  readonly headers: Headers;
  readonly auth: unknown;
  readonly client: Client;
  readonly incoming: IncomingBody;
  readonly store: IdempotencyStore | undefined;
  readonly traceId: string;
}

type Run = () => Promise<Response>;

const KEY_FORMAT = /^[\x20-\x7E]{1,255}$/;

const REFUSALS: Readonly<Record<IdempotencyRefusal, string>> = {
  inProgress: 'a request with this idempotency key is still in progress; retry once it has completed',
  reused: 'this idempotency key was used with a different request; send a new key for a new request',
};

function keyOf(headers: Headers, header: string): string | undefined {
  const key = headers.get(header);
  if (key === null) {
    return undefined;
  }

  if (!KEY_FORMAT.test(key)) {
    throw new InputError('headers', [
      { path: [header], code: 'invalid_format', message: 'must be 1 to 255 printable ASCII characters' },
    ]);
  }

  return key;
}

function valueAt(path: string, auth: unknown, client: Client): unknown {
  if (REQUEST_SCOPE_PATHS.includes(path)) {
    return Reflect.get(client, path);
  }

  const [, ...keys] = path.split('.');

  return keys.reduce<unknown>(
    (value, key) => (value instanceof Object ? Reflect.get(value, key) : undefined),
    auth,
  );
}

function scopeOf(paths: readonly string[], auth: unknown, client: Client): string | undefined {
  for (const path of paths) {
    const value = valueAt(path, auth, client);
    if (value !== undefined && value !== null) {
      return `${path}=${typeof value === 'string' ? value : canonicalJson(value)}`;
    }
  }

  return undefined;
}

function canonicalBody(bytes: Uint8Array): string {
  const text = new TextDecoder().decode(bytes);
  if (text.trim() === '') {
    return '{}';
  }

  try {
    return canonicalJson(JSON.parse(text));
  } catch {
    return text;
  }
}

function targetOf(url: URL): string {
  const query = new URLSearchParams(url.searchParams);
  query.sort();

  return `${url.pathname}?${query.toString()}`;
}

async function fingerprintOf(call: IdempotentCall): Promise<string> {
  const bytes = (await call.incoming.body()) ?? new Uint8Array();

  return sha256(`${call.route.key}\n${targetOf(call.url)}\n${canonicalBody(bytes)}`);
}

function deadlineOf(): number | undefined {
  const deadline = current()?.deadline;

  return deadline === undefined ? undefined : Temporal.Instant.from(deadline).epochMilliseconds;
}

function requireStore(store: IdempotencyStore | undefined, route: string): IdempotencyStore {
  if (store === undefined) {
    throw new MurmurError(`route ${route} is idempotent but this host has no sqlite store`, {
      code: 'idempotency-no-store',
      retryable: false,
    });
  }

  return store;
}

function responseOf(stored: StoredResponse, extra: Readonly<Record<string, string>> = {}): Response {
  const body = stored.body.byteLength === 0 ? null : (stored.body as Uint8Array<ArrayBuffer>);
  const headers = new Headers();

  for (const [name, value] of [...stored.headers, ...Object.entries(extra)]) {
    headers.append(name, value);
  }

  return new Response(body, { status: stored.status, headers });
}

function refusal(call: IdempotentCall, kind: IdempotencyRefusal): Response {
  const { errors } = call.route.settings;
  const { status, code } = errors.idempotency[kind];

  return renderFailure({ status, code, message: REFUSALS[kind] }, errors, call.traceId);
}

function unkeepable(response: Response, limit: number): boolean {
  const length = Number(response.headers.get('content-length') ?? 0);
  const type = response.headers.get('content-type') ?? '';

  return length > limit || type.startsWith('text/event-stream');
}

async function stored(response: Response): Promise<StoredResponse> {
  const body = new Uint8Array(await response.arrayBuffer());

  return { status: response.status, headers: [...response.headers], body };
}

async function runOnce(
  call: IdempotentCall,
  store: IdempotencyStore,
  claim: Claim,
  lock: number,
  run: Run,
): Promise<Response> {
  const response = await run().catch(async (error: unknown) => {
    await store.release(claim, lock);

    throw error;
  });

  const limit = call.route.options.maxBodyBytes ?? call.route.settings.maxBodyBytes;
  if (response.status < 200 || response.status > 299 || unkeepable(response, limit)) {
    await store.release(claim, lock);

    return response;
  }

  const kept = await stored(response);
  if (kept.body.byteLength > limit) {
    await store.release(claim, lock);
  } else {
    await store.complete(claim, lock, kept);
  }

  return responseOf(kept);
}

async function claimed(
  call: IdempotentCall,
  options: IdempotentOptions,
  key: string,
  scope: string,
): Promise<Claim> {
  return {
    scope,
    key,
    route: call.route.key,
    fingerprint: await fingerprintOf(call),
    ttlMs: options.ttlMs ?? IDEMPOTENCY_DEFAULTS.ttlMs,
    deadline: deadlineOf(),
  };
}

export async function idempotently(call: IdempotentCall, run: Run): Promise<Response> {
  const options = call.route.options.idempotent;
  const key =
    options === undefined ? undefined : keyOf(call.headers, options.header ?? IDEMPOTENCY_DEFAULTS.header);
  const scope = options === undefined ? undefined : scopeOf(options.scope, call.auth, call.client);

  if (options === undefined || key === undefined || scope === undefined) {
    return run();
  }

  const store = requireStore(call.store, call.route.key);
  const claim = await claimed(call, options, key, scope);
  const outcome = await store.claim(claim);

  switch (outcome.kind) {
    case 'replay':
      return responseOf(outcome.response, { 'idempotent-replayed': 'true' });
    case 'inProgress':
    case 'reused':
      return refusal(call, outcome.kind);
    case 'run':
      return runOnce(call, store, claim, outcome.lock, run);
  }
}
