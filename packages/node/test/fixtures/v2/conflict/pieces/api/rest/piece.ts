import { Piece, Serve } from 'murmur';

import web from '../../../../web/capabilities/web/capability.ts';

export class Rest extends Piece() {
  @Serve(web.get('/todos/:id'))
  show(): { served: string } {
    return { served: '/todos/:id' };
  }
}
