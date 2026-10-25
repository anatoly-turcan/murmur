import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { MurmurError } from 'murmur';
import { z } from 'zod';

export interface HttpServer {
  readonly brand: 'murmur.http';
  readonly host: string;
  readonly port: number;
  readonly url: string;
  close(signal: AbortSignal): Promise<void>;
}

export const httpConfig = z.object({
  port: z.number().int().min(0).max(65_535).default(3000),
  host: z.string().default('127.0.0.1'),
  trustProxy: z.boolean().default(false),
  healthz: z.boolean().default(false),
});

export type HttpConfig = z.infer<typeof httpConfig>;

export type RequestListener = (req: IncomingMessage, res: ServerResponse) => void;

function urlOf(host: string, port: number): string {
  if (host.includes(':')) {
    return `http://[${host}]:${port}`;
  }

  return `http://${host}:${port}`;
}

function listening(server: Server, port: number, host: string): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve(server.address() as AddressInfo);
    });
  });
}

function closer(server: Server, endStreams: () => void): HttpServer['close'] {
  return (signal) => {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeIdleConnections();
    endStreams();
    signal.addEventListener('abort', () => server.closeAllConnections(), { once: true });

    return closed;
  };
}

export async function listen(
  config: HttpConfig,
  onRequest: RequestListener,
  endStreams: () => void = () => {},
): Promise<HttpServer> {
  const server = createServer(onRequest);
  const address = await listening(server, config.port, config.host);

  return {
    brand: 'murmur.http',
    host: config.host,
    port: address.port,
    url: urlOf(config.host, address.port),
    close: closer(server, endStreams),
  };
}

export function asHttpServer(value: unknown): HttpServer {
  if (typeof value === 'object' && value !== null && Reflect.get(value, 'brand') === 'murmur.http') {
    return value as HttpServer;
  }

  throw new MurmurError('expected the http capability instance', { retryable: false });
}
