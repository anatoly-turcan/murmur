import { conflict, versionConflict } from '../../http/errors.ts';

export function assertVersion(ifMatch: number | null, version: number): void {
  if (ifMatch !== null && ifMatch !== version) throw versionConflict(version);
}

export function assertDeleted(row: { deleted_at: number | null }): void {
  if (row.deleted_at === null) throw conflict('not_deleted', 'The object is not deleted.');
}
