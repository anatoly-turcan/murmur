import { PayloadTooLargeError } from 'murmur';

import { hasBody, type BodySource } from './input.ts';

function declaredLength(request: Request): number | undefined {
  const header = request.headers.get('content-length');
  if (header === null) {
    return undefined;
  }

  return Number(header);
}

async function readLimited(
  body: ReadableStream<Uint8Array>,
  limit: number,
  key: string,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let bytes = 0;

  for await (const chunk of body) {
    bytes += chunk.byteLength;

    if (bytes > limit) {
      await body.cancel().catch(() => {});

      throw new PayloadTooLargeError(key, bytes, limit);
    }

    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

function precheck(request: Request, limit: number, key: string): void {
  const declared = declaredLength(request);
  if (hasBody(request.method) && declared !== undefined && declared > limit) {
    throw new PayloadTooLargeError(key, declared, limit);
  }
}

async function bufferBody(request: Request, limit: number, key: string): Promise<Uint8Array | undefined> {
  if (!hasBody(request.method) || request.body === null) {
    return undefined;
  }

  return readLimited(request.body, limit, key);
}

export interface IncomingBody {
  readonly body: BodySource;
  readonly raw: () => Request;
}

function limitedStream(
  body: ReadableStream<Uint8Array>,
  limit: number,
  key: string,
): ReadableStream<Uint8Array> {
  let bytes = 0;

  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform: (chunk, controller) => {
        bytes += chunk.byteLength;

        if (bytes > limit) {
          controller.error(new PayloadTooLargeError(key, bytes, limit));

          return;
        }

        controller.enqueue(chunk);
      },
    }),
  );
}

function withBody(request: Request, body: NonNullable<RequestInit['body']>): Request {
  const { method, headers, signal } = request;
  const init: RequestInit & { duplex: 'half' } = { method, headers, signal, body, duplex: 'half' };

  return new Request(request.url, init);
}

function unread(request: Request, limit: number, key: string): Request {
  if (!hasBody(request.method) || request.body === null) {
    return request;
  }

  return withBody(request, limitedStream(request.body, limit, key));
}

export function bufferedBody(request: Request, limit: number, key: string): IncomingBody {
  precheck(request, limit, key);
  let bytes: Uint8Array | undefined;
  let read: Promise<Uint8Array | undefined> | undefined;
  let rawUnread: Request | undefined;
  const body = () => {
    read ??= bufferBody(request, limit, key).then((buffered) => {
      bytes = buffered;

      return buffered;
    });

    return read;
  };
  const raw = () => {
    if (bytes !== undefined) {
      return withBody(request, bytes as Uint8Array<ArrayBuffer>);
    }

    if (read !== undefined) {
      return request;
    }

    rawUnread ??= unread(request, limit, key);

    return rawUnread;
  };

  return { body, raw };
}

export function streamedBody(request: Request): IncomingBody {
  let read: Promise<Uint8Array | undefined> | undefined;
  const body = () => {
    read ??= request.body === null ? Promise.resolve(undefined) : request.bytes();

    return read;
  };

  return { body, raw: () => request };
}
