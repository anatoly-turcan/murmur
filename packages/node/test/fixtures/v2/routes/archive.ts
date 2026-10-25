import { Piece, Serve } from 'murmur';

import web, { type WebRequest } from '../web/capabilities/web/capability.ts';

export class Archive extends Piece() {
  @Serve(web.get('/todos/:id'))
  show(req: WebRequest): { route: string; id: string | undefined } {
    return { route: 'show', id: req.params['id'] };
  }

  @Serve(web.get('/todos/archive'))
  archive(): { route: string } {
    return { route: 'archive' };
  }

  @Serve(web.raw('GET', '/files/*rest'))
  file(req: WebRequest): Response {
    return Response.json({ route: 'file', rest: req.params['rest'] });
  }
}
