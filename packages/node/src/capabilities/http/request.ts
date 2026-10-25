import type { Rejection } from 'murmur';

import type { Client } from './client.ts';
import type { InputSource } from './input.ts';
import { readParts, type ReadResult, type ReadSpec } from './read.ts';
import { renderOutcome, type OutcomeContext, type ReplyBody, type ReplyOptions } from './respond.ts';

type JsonObject = object & { readonly getTime?: never; readonly call?: never };

export type HttpResult = Response | JsonObject | Rejection | null | undefined;

export interface HttpRequest<Auth = undefined> {
  readonly method: string;
  readonly url: URL;
  readonly path: string;
  readonly params: Readonly<Record<string, string | undefined>>;
  readonly query: URLSearchParams;
  readonly headers: Headers;
  readonly peer: string;
  readonly ip: string;
  readonly auth: Auth;
  readonly traceId: string;
  readonly signal: AbortSignal;
  readonly raw: Request;
  read<const S extends ReadSpec>(spec: S): Promise<ReadResult<S>>;
  reply<O>(outcome: O, options?: ReplyOptions<ReplyBody<O>>): Response;
}

export interface HttpRequestInit {
  readonly source: InputSource;
  readonly url: URL;
  readonly client: Client;
  readonly auth: unknown;
  readonly raw: () => Request;
  readonly outcome: OutcomeContext;
  readonly signal: AbortSignal;
}

export function responseSent(): DOMException {
  return new DOMException('the response was sent', 'AbortError');
}

export function createHttpRequest(init: HttpRequestInit): HttpRequest<unknown> {
  const { source, url, outcome } = init;

  return {
    method: source.method,
    url,
    path: url.pathname,
    params: source.params,
    query: source.query,
    headers: source.headers,
    peer: init.client.peer,
    ip: init.client.ip,
    auth: init.auth,
    traceId: outcome.traceId,
    signal: init.signal,
    get raw() {
      return init.raw();
    },
    read: (spec) => readParts(spec, source),
    reply: (value, options) => renderOutcome(value, outcome, options as ReplyOptions<unknown>),
  };
}
