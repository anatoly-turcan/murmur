import { Piece, Serve } from 'murmur';

import web from '../../capabilities/web/capability.ts';

export class Catchall extends Piece() {
  @Serve(web.raw('GET', '/*rest'))
  async page(): Promise<Response> {
    return Response.json({ from: 'catchall' });
  }
}
