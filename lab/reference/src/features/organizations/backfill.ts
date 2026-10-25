import type { DatabaseSync } from 'node:sqlite';
import { all, run } from '../../db/sql.ts';
import type { Plan, WorkspaceRow } from '../../domain/rows.ts';
import { firstFreeSlug } from '../../text/slug.ts';
import { insertOrganization, orgSlugTaken } from './store.ts';

function adoptWorkspace(db: DatabaseSync, ws: WorkspaceRow, plan: Plan, now: number): void {
  const slug = firstFreeSlug(ws.slug, (s) => orgSlugTaken(db, s));
  const org = insertOrganization(db, { name: ws.name, slug, plan, ownerId: ws.owner_id }, now);
  run(
    db,
    `INSERT INTO org_memberships (organization_id, user_id, role, joined_at)
     SELECT ?, user_id, 'org_member', joined_at FROM memberships WHERE workspace_id = ? AND user_id <> ?`,
    org.id,
    ws.id,
    ws.owner_id,
  );
  run(db, 'UPDATE workspaces SET organization_id = ? WHERE id = ?', org.id, ws.id);
}

export function backfillOrganizations(db: DatabaseSync, now: number, plan: Plan = 'free'): number {
  const orphans = all<WorkspaceRow>(db, 'SELECT * FROM workspaces WHERE organization_id IS NULL ORDER BY id');
  for (const ws of orphans) adoptWorkspace(db, ws, plan, now);

  return orphans.length;
}
