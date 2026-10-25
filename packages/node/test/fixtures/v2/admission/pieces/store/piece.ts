import { Handle, Piece } from 'murmur';

import { GetItem, type Item } from '../../contracts/items.ts';

export class Store extends Piece() {
  @Handle(GetItem)
  async get(input: GetItem): Promise<Item | null> {
    if (input.id === 'missing') {
      return null;
    }

    return { id: input.id, name: 'kettle' };
  }
}
