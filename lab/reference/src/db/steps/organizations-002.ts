import type { DatabaseSync } from 'node:sqlite';
import { all, insert, one, run } from '../sql.ts';
import { firstFreeSlug, slugKey } from '../../text/slug.ts';

interface V1Workspace {
  id: number;
  name: string;
  slug: string;
  owner_id: number;
}

function slugTaken(db: DatabaseSync, slug: string): boolean {
  return one(db, 'SELECT 1 AS x FROM organizations WHERE slug_key = ? AND deleted_at IS NULL', slugKey(slug)) !== undefined;
}

function adopt(db: DatabaseSync, ws: V1Workspace, now: number): void {
  const slug = firstFreeSlug(ws.slug, (s) => slugTaken(db, s));
  const orgId = insert(
    db,
    `INSERT INTO organizations (name, slug, slug_key, plan, owner_id, created_at, updated_at) VALUES (?, ?, ?, 'free', ?, ?, ?)`,
    ws.name,
    slug,
    slugKey(slug),
    ws.owner_id,
    now,
    now,
  );
  run(db, `INSERT INTO org_memberships (organization_id, user_id, role, joined_at) VALUES (?, ?, 'org_owner', ?)`, orgId, ws.owner_id, now);
  run(
    db,
    `INSERT INTO org_memberships (organization_id, user_id, role, joined_at)
     SELECT ?, user_id, 'org_member', joined_at FROM memberships WHERE workspace_id = ? AND user_id <> ?`,
    orgId,
    ws.id,
    ws.owner_id,
  );
  run(db, 'UPDATE workspaces SET organization_id = ? WHERE id = ?', orgId, ws.id);
}

// Frozen with the integer-id schema of 002-organizations.sql; later id changes must not reach it.
export function backfillOrganizations002(db: DatabaseSync, now: number): void {
  const orphans = all<V1Workspace>(db, 'SELECT id, name, slug, owner_id FROM workspaces WHERE organization_id IS NULL ORDER BY id');
  for (const ws of orphans) adopt(db, ws, now);
}
