import { Handle, NonRetryableError, Piece, reject, type Rejection } from 'murmur';

import {
  DeleteItem,
  FailItem,
  GetItem,
  ListItems,
  UpdateItem,
  type Empty,
  type Item,
} from '../../contracts/items.ts';

export class Store extends Piece() {
  @Handle(GetItem)
  async get(input: GetItem): Promise<Item | null> {
    if (input.id === '404') {
      return null;
    }

    return { id: input.id, title: 'milk', version: 3 };
  }

  @Handle(ListItems)
  async list(input: ListItems): Promise<Item[]> {
    return [{ id: 'q', title: JSON.stringify(input), version: 1 }];
  }

  @Handle(UpdateItem)
  async update(input: UpdateItem): Promise<Item | Rejection> {
    if (input.ifMatch !== null && input.ifMatch !== '3') {
      return reject(409, 'The object changed since you read it.', {
        code: 'version_conflict',
        details: [{ path: 'if-match', code: 'stale', current: 3 }],
      });
    }

    return { id: input.id, title: input.title, version: 4 };
  }

  @Handle(DeleteItem)
  async remove(input: DeleteItem): Promise<Empty | Rejection> {
    if (input.id === 'locked') {
      return reject(423, 'The object is locked.', { code: 'locked', headers: { 'retry-after': '5' } });
    }

    return {};
  }

  @Handle(FailItem)
  async fail(_input: FailItem): Promise<Item> {
    throw new NonRetryableError('store down');
  }
}
