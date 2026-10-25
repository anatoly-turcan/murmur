import type { HttpResult } from '@murmur/node/capabilities';
import { IfMatch, Piece, reject, Serve } from 'murmur';
import { z } from 'zod';

import web, { type WebRequest } from '../../capabilities/web/capability.ts';
import { DeleteItem, FailItem, GetItem, ListItems, UpdateItem } from '../../contracts/items.ts';

@Serve(web.delete('/items/:id', { status: 204 }), DeleteItem)
@Serve(web.post('/items/:id/fail'), FailItem)
export class Edge extends Piece() {
  @Serve(web.get('/items/:id'))
  async show(req: WebRequest): Promise<HttpResult> {
    const { params } = await req.read({ params: { id: z.coerce.number().int().positive() } });
    const item = await this.request(GetItem, { id: String(params.id) });

    return req.reply(item, { etag: (found) => found.version, headers: { 'x-item': 'yes' } });
  }

  @Serve(web.patch('/items/:id'))
  async update(req: WebRequest): Promise<HttpResult> {
    const { params, headers, body } = await req.read({
      params: { id: z.string().regex(/^i\d+$/) },
      headers: { 'if-match': IfMatch },
      body: { title: z.string().min(3) },
    });

    const out = await this.request(UpdateItem, { id: params.id, ifMatch: headers['if-match'], ...body });

    return req.reply(out, { etag: (item) => item.version });
  }

  @Serve(web.get('/items'))
  async list(req: WebRequest): Promise<HttpResult> {
    const { query } = await req.read({
      query: { tag: z.array(z.string()).optional(), limit: z.number().int().max(50).optional() },
    });

    return this.request(ListItems, query);
  }

  @Serve(web.get('/headers'))
  async headers(req: WebRequest): Promise<HttpResult> {
    const { headers } = await req.read({ headers: { 'x-opt': z.string().optional() } });

    return req.reply({ opt: headers['x-opt'] });
  }

  @Serve(web.get('/headers/mixed-case'))
  async mixedCase(req: WebRequest): Promise<HttpResult> {
    const { headers } = await req.read({ headers: { 'If-Match': IfMatch } });

    return req.reply({ ifMatch: headers['If-Match'] });
  }

  @Serve(web.post('/echo'))
  async echo(req: WebRequest): Promise<HttpResult> {
    const { body } = await req.read({ body: { a: z.number().optional() } });

    return body;
  }

  @Serve(web.get('/outcomes/rejection'))
  rejection(req: WebRequest): HttpResult {
    return req.reply(reject(403, 'Only admins may look.', { code: 'admins_only' }), {
      headers: { 'x-a': '1' },
    });
  }

  @Serve(web.get('/outcomes/null'))
  nothing(req: WebRequest): HttpResult {
    return req.reply(null);
  }

  @Serve(web.get('/outcomes/none'))
  none(req: WebRequest): HttpResult {
    return req.reply(undefined);
  }

  @Serve(web.get('/outcomes/object'))
  object(req: WebRequest): HttpResult {
    return req.reply({ ok: true }, { status: 202, headers: { 'x-a': '1' } });
  }

  @Serve(web.get('/outcomes/direct-null'))
  directNull(): HttpResult {
    return null;
  }

  @Serve(web.get('/outcomes/direct-rejection'))
  directRejection(): HttpResult {
    return reject(410, 'The object is gone.', { code: 'gone' });
  }
}
