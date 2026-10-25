import { jobs, sqlite } from '@murmur/node/capabilities';
import { Handle, Piece } from 'murmur';

import { AuditItem, CreateItem, ImportItem, IndexItem, type Item } from '../../contracts/kit.ts';

export class Items extends Piece({ needs: { db: sqlite, jobs } }) {
  @Handle(CreateItem)
  async create(input: CreateItem): Promise<Item> {
    const item = { id: this.ids.uuid(), title: input.title };

    await this.db.transaction(async (tx) => {
      await tx.insert('items', item);
      await this.jobs.enqueue(IndexItem, { id: item.id }, { dedupeKey: `index:${item.id}` });
      await this.jobs.enqueue(AuditItem, { id: item.id });
    });

    return item;
  }

  @Handle(ImportItem)
  async import(input: ImportItem): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.jobs.enqueue(IndexItem, { id: input.id });
      await tx.insert('items', { id: input.id, title: input.title });
    });
  }

  @Handle(IndexItem)
  async index(input: IndexItem): Promise<void> {
    await this.db.run('UPDATE items SET indexed = 1 WHERE id = ?', input.id);
  }
}
