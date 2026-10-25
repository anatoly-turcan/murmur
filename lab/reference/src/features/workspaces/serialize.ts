import type { Role, WorkspaceRow } from '../../domain/rows.ts';
import { iso, isoOrNull } from '../../time/format.ts';

export function serializeWorkspace(ws: WorkspaceRow, role: Role | null): Record<string, unknown> {
  return {
    id: ws.id,
    name: ws.name,
    slug: ws.slug,
    owner_id: ws.owner_id,
    organization_id: ws.organization_id,
    version: ws.version,
    created_at: iso(ws.created_at),
    updated_at: iso(ws.updated_at),
    deleted_at: isoOrNull(ws.deleted_at),
    my_role: role,
  };
}
