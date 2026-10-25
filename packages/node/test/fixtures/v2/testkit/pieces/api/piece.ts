import type { HttpResult } from '@murmur/node/capabilities';
import { Piece, Serve } from 'murmur';

import web, { type WebRequest } from '../../capabilities/web/capability.ts';
import { CreateItem } from '../../contracts/kit.ts';

export class Api extends Piece() {
  @Serve(web.post('/items', { status: 201 }))
  async create(req: WebRequest): Promise<HttpResult> {
    const { body } = await req.read({ body: CreateItem.input });

    return req.reply(await this.request(CreateItem, body));
  }
}
