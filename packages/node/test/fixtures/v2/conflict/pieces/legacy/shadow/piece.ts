import { Piece, Serve } from 'murmur';

import web from '../../../../web/capabilities/web/capability.ts';

export class Shadow extends Piece() {
  @Serve(web.get('/todos/:slug'))
  show(): { served: string } {
    return { served: '/todos/:slug' };
  }
}
