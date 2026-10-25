import { defineCapability, MurmurError, type RunContext } from 'murmur';
import { z } from 'zod';

import { current } from '../context.ts';
import { callableToken } from './token.ts';
import { traceHeaders } from './trace-headers.ts';
import type { Fetch } from './types.ts';

interface FetchSettings {
  readonly timeoutMs: number;
}

function linkAbort(
  target: AbortController,
  sources: readonly (AbortSignal | null | undefined)[],
): () => void {
  const removers = sources.flatMap((source) => {
    if (source === null || source === undefined) {
      return [];
    }

    if (source.aborted) {
      target.abort(source.reason);

      return [];
    }

    const listener = () => target.abort(source.reason);
    source.addEventListener('abort', listener, { once: true });

    return [() => source.removeEventListener('abort', listener)];
  });

  return () => {
    for (const remove of removers) {
      remove();
    }
  };
}

function traced(headers: Headers, run: RunContext | undefined): Headers {
  if (run === undefined) {
    return headers;
  }

  for (const [name, value] of Object.entries(traceHeaders(run.traceId))) {
    headers.set(name, value);
  }

  return headers;
}

function tracedFetch(settings: FetchSettings, runOf: () => RunContext | undefined): Fetch {
  return async (input, init = {}) => {
    const run = runOf();
    const ctrl = new AbortController();
    const unlink = linkAbort(ctrl, [run?.signal, init.signal]);
    const timer = setTimeout(() => {
      ctrl.abort(
        new MurmurError(`fetch timed out after ${settings.timeoutMs} ms`, { code: 'fetch-timeout' }),
      );
    }, settings.timeoutMs);
    const headers = traced(new Headers(init.headers), run);

    try {
      return await globalThis.fetch(input, { ...init, headers, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
      unlink();
    }
  };
}

const FETCH_DOCS = `# fetch

The fetch handle \`(input, init?)\`: the platform fetch bound to the current delivery; returns a standard \`Response\`.
The piece names the field (\`needs: { fetch }\` → \`this.fetch\`); the examples below call it \`fetch\`.
\`const body = await (await fetch(url)).json()\`; non-2xx statuses resolve, they do not throw.

- Aborts when the delivery's signal aborts (handler timeout, shutdown) or after \`timeoutMs\`.
- Adds \`x-murmur-trace\` and \`traceparent\` headers from the current trace.
- Config: \`timeoutMs\` (default 10000).
`;

function startFetch(settings: FetchSettings): Fetch {
  return tracedFetch(settings, current);
}

export const fetch = callableToken(
  defineCapability({
    name: 'fetch',
    config: z.object({ timeoutMs: z.number().default(10_000) }),
    docs: FETCH_DOCS,
    start: ({ config }) => startFetch({ timeoutMs: config.timeoutMs }),
    fake: async () => (await import('../testing/fakes.ts')).unstubbedFetch(),
  }),
);
