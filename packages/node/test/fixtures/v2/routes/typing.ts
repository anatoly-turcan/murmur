import type { HttpRequest } from '@murmur/node/capabilities';
import { IfMatch, Piece, Serve } from 'murmur';
import { z } from 'zod';

import web, { type WebRequest } from '../web/capabilities/web/capability.ts';
import { Authenticate, type Quota, RateLimit } from '../web/contracts/auth.ts';
import { RequireAdmin } from '../web/contracts/grants.ts';
import { GetTodo } from '../web/contracts/todos.ts';

export class Typing extends Piece() {
  @Serve(web.get('/open', { skip: [Authenticate, RateLimit] }))
  open(req: HttpRequest) {
    // @ts-expect-error req.auth is undefined on a fully open route
    return { user: req.auth.userId };
  }

  // @ts-expect-error WebRequest expects Authenticate, which this route skips
  @Serve(web.get('/metered', { skip: [Authenticate] }))
  metered(req: WebRequest) {
    return { user: req.auth.userId };
  }

  @Serve(web.get('/quota', { skip: [Authenticate] }))
  quota(req: HttpRequest<Quota>) {
    return { remaining: req.auth.remaining };
  }

  // @ts-expect-error a Date is not a JSON result
  @Serve(web.get('/now'))
  now(_req: WebRequest) {
    return new Date();
  }

  // @ts-expect-error a raw binding must return a Response
  @Serve(web.raw('POST', '/raw'))
  raw(_req: WebRequest) {
    return { ok: true };
  }

  @Serve(web.get('/todos/:id'))
  async show(req: WebRequest) {
    const { params } = await req.read({ params: GetTodo.input });

    return { id: params.id, by: req.auth.userId, left: req.auth.remaining };
  }

  @Serve(web.get('/headers'))
  async headers(req: WebRequest) {
    const { headers } = await req.read({
      headers: { 'x-a': z.string().optional(), 'if-match': IfMatch, 'x-b': z.string() },
    });

    const optional: string | null = headers['x-a'];
    const ifMatch: string | null = headers['if-match'];
    const required: string = headers['x-b'];
    // @ts-expect-error a missing optional header is null, never undefined
    const absent: string | undefined = headers['x-a'];

    return { optional, ifMatch, required, absent };
  }
}

export const typedPaths = [
  // @ts-expect-error a path param missing from the contract input
  Serve(web.get('/todos/:todoId'), GetTodo),
];

export function straySkip() {
  // @ts-expect-error skip names a guard that is not a default of the token
  return web.get('/stray', { skip: [RequireAdmin] });
}
