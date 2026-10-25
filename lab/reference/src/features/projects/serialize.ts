import type { ProjectRow } from '../../domain/rows.ts';
import { iso, isoOrNull } from '../../time/format.ts';

export function serializeProject(p: ProjectRow): Record<string, unknown> {
  return {
    id: p.id,
    workspace_id: p.workspace_id,
    name: p.name,
    slug: p.slug,
    description: p.description,
    creator_id: p.creator_id,
    version: p.version,
    created_at: iso(p.created_at),
    updated_at: iso(p.updated_at),
    deleted_at: isoOrNull(p.deleted_at),
  };
}
