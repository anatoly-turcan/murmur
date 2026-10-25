import type { HttpRequest } from '@murmur/node/capabilities';
import { Handle, Piece, Serve } from 'murmur';

import web, { type WebRequest } from '../../../capabilities/web/capability.ts';
import { Authenticate, type Principal, type Quota, RateLimit } from '../../../contracts/auth.ts';
import { type AdminGrant, RequireAdmin } from '../../../contracts/grants.ts';
import { GetStreamStats, type StreamStats, Tick } from '../../../contracts/stream.ts';

type Client = ReadableStreamDefaultController<Uint8Array>;

const encoder = new TextEncoder();

export class Extra extends Piece() {
  private readonly clients = new Set<Client>();
  private aborted = 0;
  private dropped = 0;

  @Serve(web.get('/admin/whoami', { guards: [RequireAdmin] }))
  whoami(req: HttpRequest<Principal & Quota & AdminGrant>): { userId: string; admin: boolean } {
    return { userId: req.auth.userId, admin: req.auth.admin };
  }

  @Serve(web.get('/open', { skip: [Authenticate, RateLimit] }))
  open(req: HttpRequest): { auth: unknown } {
    return { auth: req.auth ?? null };
  }

  @Serve(web.raw('POST', '/uploads/:bucket'))
  async upload(req: WebRequest): Promise<Response> {
    const bytes = await req.raw.bytes();

    return Response.json({ bucket: req.params['bucket'], bytes: bytes.byteLength }, { status: 201 });
  }

  @Serve(web.post('/sizes'))
  async size(req: WebRequest): Promise<{ bytes: number }> {
    const bytes = await req.raw.bytes();

    return { bytes: bytes.byteLength };
  }

  @Serve(web.get('/slow'))
  async slow(req: WebRequest): Promise<{ late: boolean }> {
    await new Promise((resolve) => req.signal.addEventListener('abort', resolve));

    return { late: true };
  }

  @Serve(web.get('/ticks'))
  ticks(req: WebRequest): Response {
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.clients.add(controller);
        req.signal.addEventListener('abort', () => {
          this.aborted += 1;
        });

        for (const word of ['one', 'two', 'three']) {
          controller.enqueue(encoder.encode(`${word}\n`));
        }
      },
    });

    return new Response(body, { headers: { 'content-type': 'text/plain' } });
  }

  @Handle(Tick)
  tick(event: Tick): void {
    const frame = encoder.encode(`tick ${event.n}\n`);
    for (const client of this.clients) {
      this.send(client, frame);
    }
  }

  @Handle(GetStreamStats)
  async stats(): Promise<StreamStats> {
    return { clients: this.clients.size, aborted: this.aborted, dropped: this.dropped };
  }

  private send(client: Client, frame: Uint8Array): void {
    try {
      client.enqueue(frame);
    } catch {
      this.clients.delete(client);
      this.dropped += 1;
    }
  }
}
