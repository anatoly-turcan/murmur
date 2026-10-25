import type { DatabaseSync } from 'node:sqlite';
import { one } from '../db/sql.ts';
import type { UserRow } from './rows.ts';
import type { Id } from '../ids/uuid.ts';

export interface ActorRef {
  id: Id;
  name: string;
  deleted: boolean;
}

export const DELETED_USER_NAME = 'Deleted user';

export function actorRef(user: Pick<UserRow, 'id' | 'name' | 'deactivated_at'>): ActorRef {
  return user.deactivated_at === null
    ? { id: user.id, name: user.name, deleted: false }
    : { id: user.id, name: DELETED_USER_NAME, deleted: true };
}

export function loadUser(db: DatabaseSync, id: Id): UserRow | undefined {
  return one<UserRow>(db, 'SELECT * FROM users WHERE id = ?', id);
}

export function actorRefById(db: DatabaseSync, id: Id): ActorRef {
  const user = loadUser(db, id);

  return user ? actorRef(user) : { id, name: DELETED_USER_NAME, deleted: true };
}
