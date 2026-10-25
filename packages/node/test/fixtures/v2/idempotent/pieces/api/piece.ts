import type { HttpRequest, HttpResult } from '@murmur/node/capabilities';
import { NonRetryableError, Piece, reject, Serve } from 'murmur';
import { z } from 'zod';

import web, { type WebRequest } from '../../capabilities/web/capability.ts';
import { Authenticate } from '../../contracts/auth.ts';
import { gate } from './gate.ts';

const Order = { item: z.string(), outcome: z.enum(['ok', 'reject', 'throw', 'wait']).default('ok') };

export class Orders extends Piece() {
  private calls = 0;

  @Serve(web.post('/orders', { status: 201, idempotent: { scope: ['auth.userId'] } }))
  async create(req: WebRequest): Promise<HttpResult> {
    const { body } = await req.read({ body: Order });
    this.calls += 1;
    const call = this.calls;

    if (body.outcome === 'wait') {
      await gate.open.promise;
    }

    if (body.outcome === 'reject') {
      return reject(409, 'The order conflicts.', { code: 'order_conflict' });
    }

    if (body.outcome === 'throw') {
      throw new NonRetryableError('order store down');
    }

    return req.reply({ item: body.item, seq: call }, { headers: { location: `/orders/${call}` } });
  }

  @Serve(web.delete('/orders/:id', { idempotent: { scope: ['auth.userId'] } }))
  async cancel(req: WebRequest): Promise<HttpResult> {
    const { params, query } = await req.read({
      params: { id: z.string() },
      query: { reason: z.string().optional() },
    });

    this.calls += 1;

    return req.reply({ cancelled: params.id, reason: query.reason ?? null, seq: this.calls });
  }

  @Serve(web.post('/ticks', { idempotent: { scope: ['auth.userId'] } }))
  ticks(): Response {
    this.calls += 1;

    return new Response(`data: ${this.calls}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  }

  @Serve(
    web.post('/signup', {
      status: 201,
      skip: [Authenticate],
      idempotent: { scope: ['ip'], ttlMs: 60_000 },
    }),
  )
  async signup(req: HttpRequest<undefined>): Promise<HttpResult> {
    const { body } = await req.read({ body: { name: z.string() } });
    this.calls += 1;

    return req.reply({ name: body.name, seq: this.calls });
  }
}
