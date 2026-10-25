import type { HttpRequest } from '@murmur/node/capabilities';
import { Piece, Serve } from 'murmur';
import { z } from 'zod';

import web, { type WebRequest } from '../../capabilities/web/capability.ts';
import { Authenticate, type Principal, type Rate, ResolveTarget } from '../../contracts/access.ts';
import { GetItem } from '../../contracts/items.ts';

@Serve(web.get('/items/:id', { meta: { role: 'member' } }), GetItem)
export class Items extends Piece() {
  @Serve(web.get('/whoami', { skip: [ResolveTarget] }))
  whoami(req: HttpRequest<Principal & Rate>): object {
    return req.auth;
  }

  @Serve(web.get('/public', { skip: [Authenticate, ResolveTarget] }))
  open(req: HttpRequest<Rate>): object {
    return req.auth;
  }

  @Serve(web.post('/items/:id/notes', { meta: { target: 'note' } }))
  async note(req: WebRequest): Promise<object> {
    const { body } = await req.read({ body: z.looseObject({}) });

    return { auth: req.auth, body };
  }
}
