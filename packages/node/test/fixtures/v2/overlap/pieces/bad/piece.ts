import { Piece, Serve } from 'murmur';

import web from '../../../web/capabilities/web/capability.ts';
import { Impersonate } from '../../../web/contracts/grants.ts';

export class Bad extends Piece() {
  @Serve(web.get('/whoami', { guards: [Impersonate] }))
  whoami(): { ok: boolean } {
    return { ok: true };
  }
}
