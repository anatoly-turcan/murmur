import { jobs } from '@murmur/node/capabilities';
import { Piece, Serve } from 'murmur';

import web from '../../capabilities/web/capability.ts';
import { Work } from '../../contracts/work.ts';

export class Edge extends Piece({ needs: { jobs } }) {
  @Serve(web.get('/ping'))
  async ping(): Promise<{ pong: boolean }> {
    return { pong: true };
  }

  @Serve(web.post('/work', { status: 202 }))
  async work(): Promise<{ enqueued: boolean }> {
    return this.jobs.enqueue(Work, { label: 'from edge' });
  }
}
