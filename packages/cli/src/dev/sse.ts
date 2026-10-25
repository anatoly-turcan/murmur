import type { ServerResponse } from 'node:http';

import type { Frame } from '@murmur/dev-protocol';

const PING_MS = 15_000;

interface Client {
  readonly res: ServerResponse;
  readonly accepts: (frame: Frame) => boolean;
}

export interface SseHub {
  open(
    res: ServerResponse,
    headers: Record<string, string>,
    accepts: (frame: Frame) => boolean,
  ): (frame: Frame) => void;
  broadcast(frame: Frame): void;
  close(): void;
}

function encode(frame: Frame): string {
  return `id: ${frame.seq}\nevent: ${frame.frame}\ndata: ${JSON.stringify(frame)}\n\n`;
}

export function createHub(lastSeq: () => number): SseHub {
  const clients = new Set<Client>();
  const broadcast = (frame: Frame) => {
    for (const client of clients) {
      if (client.accepts(frame)) {
        client.res.write(encode(frame));
      }
    }
  };
  const timer = setInterval(
    () => broadcast({ frame: 'ping', seq: lastSeq(), ts: new Date().toISOString() }),
    PING_MS,
  ).unref();

  return {
    open: (res, headers, accepts) => {
      res.writeHead(200, { ...headers, 'content-type': 'text/event-stream', connection: 'keep-alive' });
      res.flushHeaders();
      const client: Client = { res, accepts };
      clients.add(client);
      res.on('close', () => clients.delete(client));

      return (frame) => res.write(encode(frame));
    },
    broadcast,
    close: () => {
      clearInterval(timer);

      for (const client of clients) {
        client.res.end();
      }

      clients.clear();
    },
  };
}
