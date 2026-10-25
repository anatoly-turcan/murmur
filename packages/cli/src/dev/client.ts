import type { Frame } from '@murmur/dev-protocol';

import { CliError, EXIT } from '../errors.ts';
import { baseUrl, liveLock } from './lock.ts';

export interface HttpResult<T> {
  readonly status: number;
  readonly body: T;
}

export async function devServer(root: string): Promise<string | null> {
  const lock = await liveLock(root);

  return lock === null ? null : baseUrl(lock);
}

export async function requireDevServer(root: string): Promise<string> {
  const url = await devServer(root);
  if (url === null) {
    throw new CliError(
      EXIT.noDevServer,
      `no murmur dev server running for ${root}`,
      'start one with `murmur dev`',
    );
  }

  return url;
}

export async function getJson<T>(url: string): Promise<HttpResult<T>> {
  const response = await fetch(url);

  return { status: response.status, body: (await response.json()) as T };
}

export async function postJson<T>(url: string, body: unknown): Promise<HttpResult<T>> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  return { status: response.status, body: (await response.json()) as T };
}

function dataOf(block: string): string {
  return block
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^ /, ''))
    .join('\n');
}

export async function* frames(url: string, signal: AbortSignal): AsyncGenerator<Frame> {
  const response = await fetch(url, { signal, headers: { accept: 'text/event-stream' } });
  if (!response.ok || response.body === null) {
    throw new CliError(EXIT.noDevServer, `event stream failed: ${response.status}`);
  }

  let buffer = '';
  for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
    const blocks = (buffer + chunk).split('\n\n');
    buffer = blocks.pop() ?? '';

    for (const data of blocks.map(dataOf)) {
      if (data !== '') {
        yield JSON.parse(data) as Frame;
      }
    }
  }
}
