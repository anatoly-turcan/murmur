import { Piece } from 'murmur';

import { answer } from './helper.ts';

export class Bad extends Piece() {
  async onStart(): Promise<void> {
    this.log.info('answer', { answer });
  }
}
