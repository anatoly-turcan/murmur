import type { DatabaseSync } from 'node:sqlite';
import { auditCreated } from '../../audit/record.ts';
import { one, run } from '../../db/sql.ts';
import { immediate } from '../../db/tx.ts';
import { recordEvent } from '../../domain/events.ts';
import { assertLive } from '../../domain/load.ts';
import { assertOrgRole, findMembership, WORKSPACE_CREATORS } from '../../domain/orgs.ts';
import { assertWorkspaceCapacity } from '../../domain/plans.ts';
import type { OrganizationRow, WorkspaceRow } from '../../domain/rows.ts';
import { chooseSlug, workspaceSlugTaken } from '../../domain/slugs.ts';
import { detail, throwIfInvalid, validationFailed } from '../../http/errors.ts';
import { created } from '../../http/respond.ts';
import type { Ctx, Result } from '../../http/types.ts';
import { id, validateBody, type FieldSpecs } from '../../http/validate.ts';
import { slugKey } from '../../text/slug.ts';
import { WORKSPACE_FIELDS } from './fields.ts';
import { serializeWorkspace } from './serialize.ts';
import { newId, type Id } from '../../ids/uuid.ts';

const CREATE_FIELDS = { ...WORKSPACE_FIELDS, organization_id: id() } satisfies FieldSpecs;

interface NewWorkspace {
  name: string;
  slug: string;
  ownerId: Id;
  organizationId: Id;
}

function insertWorkspace(db: DatabaseSync, w: NewWorkspace, now: number): WorkspaceRow {
  const id = newId(now);
  run(
    db,
    'INSERT INTO workspaces (id, name, slug, slug_key, owner_id, organization_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    id,
    w.name,
    w.slug,
    slugKey(w.slug),
    w.ownerId,
    w.organizationId,
    now,
    now,
  );
  run(db, `INSERT INTO memberships (workspace_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)`, id, w.ownerId, now);

  return one<WorkspaceRow>(db, 'SELECT * FROM workspaces WHERE id = ?', id)!;
}

function targetOrganization(ctx: Ctx, organizationId: Id): OrganizationRow {
  const chain = findMembership(ctx.db, organizationId, ctx.me().id);
  if (!chain) throw validationFailed([detail('organization_id', 'invalid_organization', { message: 'Not an organization you belong to.' })]);
  assertLive(chain.org);
  assertOrgRole(chain.role, WORKSPACE_CREATORS);

  return chain.org;
}

export function createWorkspace(ctx: Ctx): Result {
  const { values, details } = validateBody(ctx.input().body, CREATE_FIELDS, { required: ['name', 'organization_id'] });
  throwIfInvalid(details);
  const me = ctx.me();

  return immediate(ctx.db, () => {
    const org = targetOrganization(ctx, values.organization_id!);
    assertWorkspaceCapacity(ctx.db, org.id, org.plan);
    const slug = chooseSlug(values.slug, values.name!, 'workspace', (s) => workspaceSlugTaken(ctx.db, s));
    const ws = insertWorkspace(ctx.db, { name: values.name!, slug, ownerId: me.id, organizationId: org.id }, ctx.now);
    auditCreated(ctx.db, ctx.now, { type: 'workspace', id: ws.id });
    recordEvent(ctx.db, ctx.now, me, { workspaceId: ws.id, type: 'workspace.created', target: { type: 'workspace', id: ws.id } });

    return created(serializeWorkspace(ws, 'owner'), ws.version);
  });
}
