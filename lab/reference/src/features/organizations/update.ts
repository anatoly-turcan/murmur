import type { DatabaseSync } from 'node:sqlite';
import { audited } from '../../audit/record.ts';
import { run } from '../../db/sql.ts';
import { immediate } from '../../db/tx.ts';
import type { Changes } from '../../domain/events.ts';
import { assertLive } from '../../domain/load.ts';
import { recordOrgEvent } from '../../domain/org-events.ts';
import { assertOrgRole, loadOrganization, ORG_MANAGERS, PLAN_MANAGERS, reloadOrganization } from '../../domain/orgs.ts';
import type { OrganizationRow, OrgRole, UserRow } from '../../domain/rows.ts';
import { slugTaken } from '../../domain/slugs.ts';
import { throwIfInvalid } from '../../http/errors.ts';
import { ok } from '../../http/respond.ts';
import type { Ctx, Result } from '../../http/types.ts';
import { validateBody, type ValuesOf } from '../../http/validate.ts';
import { slugKey } from '../../text/slug.ts';
import { assertVersion } from '../workspaces/update.ts';
import { ORG_FIELDS } from './fields.ts';
import { serializeOrganization } from './serialize.ts';
import { orgSlugTaken } from './store.ts';

type OrgPatch = ValuesOf<typeof ORG_FIELDS>;

const PATCHERS: readonly OrgRole[] = ['org_owner', 'org_admin', 'billing'];

function touchesProfile(body: Record<string, unknown>): boolean {
  return 'name' in body || 'slug' in body || !('plan' in body);
}

function assertMayPatch(role: OrgRole, body: Record<string, unknown>): void {
  if ('plan' in body) assertOrgRole(role, PLAN_MANAGERS);
  if ('name' in body || 'slug' in body) assertOrgRole(role, ORG_MANAGERS);
  assertOrgRole(role, PATCHERS);
}

function profileChanges(org: OrganizationRow, patch: OrgPatch): Changes {
  const changes: Changes = {};
  for (const key of ['name', 'slug'] as const) {
    const to = patch[key];
    if (to !== undefined && to !== org[key]) changes[key] = { from: org[key], to };
  }

  return changes;
}

function writePatch(db: DatabaseSync, org: OrganizationRow, patch: OrgPatch, now: number): OrganizationRow {
  const slug = patch.slug ?? org.slug;
  run(
    db,
    'UPDATE organizations SET name = ?, slug = ?, slug_key = ?, plan = ?, version = version + 1, updated_at = ? WHERE id = ?',
    patch.name ?? org.name,
    slug,
    slugKey(slug),
    patch.plan ?? org.plan,
    now,
    org.id,
  );

  return reloadOrganization(db, org.id);
}

function recordPatch(db: DatabaseSync, now: number, actor: UserRow, before: OrganizationRow, after: OrganizationRow, body: Record<string, unknown>): void {
  const target = { type: 'organization' as const, id: after.id };
  const data = { organization: serializeOrganization(after) };
  if (before.plan !== after.plan) {
    const changes = { plan: { from: before.plan, to: after.plan } };
    recordOrgEvent(db, now, actor, { organizationId: after.id, type: 'plan.changed', target, changes, data });
  }
  if (touchesProfile(body)) {
    recordOrgEvent(db, now, actor, { organizationId: after.id, type: 'organization.updated', target, changes: profileChanges(before, after), data });
  }
}

export function updateOrganization(ctx: Ctx): Result {
  const { org, role } = loadOrganization(ctx, ctx.params.id);
  assertLive(org);
  const { body, ifMatch } = ctx.input();
  assertMayPatch(role, body);
  const { values, details } = validateBody(body, ORG_FIELDS);
  throwIfInvalid(details);
  const me = ctx.me();

  return immediate(ctx.db, () => {
    const current = reloadOrganization(ctx.db, org.id);
    assertVersion(ifMatch, current.version);
    if (values.slug !== undefined && orgSlugTaken(ctx.db, values.slug, current.id)) throw slugTaken();
    const updated = audited(ctx.db, ctx.now, { type: 'organization', id: current.id }, 'update', () => writePatch(ctx.db, current, values, ctx.now));
    recordPatch(ctx.db, ctx.now, me, current, updated, body);

    return ok(serializeOrganization(updated), updated.version);
  });
}
