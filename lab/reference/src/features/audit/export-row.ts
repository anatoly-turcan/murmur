import { iso, isoOrNull } from '../../time/format.ts';
import type { Id } from '../../ids/uuid.ts';

export interface ExportRow {
  id: Id;
  organization_id: Id;
  requested_by: Id;
  since: number;
  until: number;
  status: 'pending' | 'ready';
  entry_count: number | null;
  created_at: number;
  completed_at: number | null;
}

export function serializeExport(row: ExportRow): Record<string, unknown> {
  return {
    id: row.id,
    organization_id: row.organization_id,
    requested_by: row.requested_by,
    since: iso(row.since),
    until: iso(row.until),
    status: row.status,
    entries: row.entry_count,
    created_at: iso(row.created_at),
    completed_at: isoOrNull(row.completed_at),
  };
}
