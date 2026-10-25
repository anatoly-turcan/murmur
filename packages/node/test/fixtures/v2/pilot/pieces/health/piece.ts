import { Piece, Serve } from 'murmur';

import web from '../../capabilities/web/capability.ts';

export class Health extends Piece() {
  @Serve(web.get('/healthz'))
  async health(): Promise<Response> {
    return Response.json({ from: 'health piece' }, { status: 503 });
  }
}
