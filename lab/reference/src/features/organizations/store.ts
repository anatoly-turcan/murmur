import type { DatabaseSync } from 'node:sqlite';
import { one, run } from '../../db/sql.ts';
import { conflict, type ApiError } from '../../http/errors.ts';
import type { OrganizationRow, OrgRole, Plan } from '../../domain/rows.ts';
import { slugKey } from '../../text/slug.ts';
import { newId, type Id } from '../../ids/uuid.ts';

export interface NewOrganization {
  name: string;
  slug: string;
  plan: Plan;
  ownerId: Id;
}

export function orgSlugTaken(db: DatabaseSync, slug: string, exceptId: Id | null = null): boolean {
  return (
    one(db, 'SELECT 1 AS x FROM organizations WHERE slug_key = ? AND deleted_at IS NULL AND id IS NOT ?', slugKey(slug), exceptId) !==
    undefined
  );
}

export function addOrgMembership(db: DatabaseSync, organizationId: Id, userId: Id, role: OrgRole, now: number): void {
  run(db, 'INSERT INTO org_memberships (organization_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)', organizationId, userId, role, now);
}

export function insertOrganization(db: DatabaseSync, org: NewOrganization, now: number): OrganizationRow {
  const id = newId(now);
  run(
    db,
    'INSERT INTO organizations (id, name, slug, slug_key, plan, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    id,
    org.name,
    org.slug,
    slugKey(org.slug),
    org.plan,
    org.ownerId,
    now,
    now,
  );
  addOrgMembership(db, id, org.ownerId, 'org_owner', now);

  return one<OrganizationRow>(db, 'SELECT * FROM organizations WHERE id = ?', id)!;
}

export function orgSoleOwner(details: ApiError['details'] = []): ApiError {
  return conflict('sole_owner', 'The organization owner must transfer ownership first.', details);
}
