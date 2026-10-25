import { Piece, Serve } from 'murmur';

import web from '../../../../web/capabilities/web/capability.ts';

export class Feed extends Piece() {
  @Serve(web.get('/todos/events'))
  show(): { served: string } {
    return { served: '/todos/events' };
  }
}
