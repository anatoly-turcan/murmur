import type { DatabaseSync } from 'node:sqlite';
import { one } from '../../db/sql.ts';
import { actorRef } from '../../domain/actor.ts';
import { limitsOf } from '../../domain/plans.ts';
import type { OrganizationRow, OrgEventRow, OrgRole } from '../../domain/rows.ts';
import { iso, isoOrNull } from '../../time/format.ts';
import type { Id } from '../../ids/uuid.ts';

export interface OrgMemberRow {
  organization_id: Id;
  user_id: Id;
  role: OrgRole;
  joined_at: number;
  name: string;
  email: string;
}

export interface OrgEventWithActor extends OrgEventRow {
  actor_name: string;
  actor_deactivated_at: number | null;
}

export const ORG_MEMBER_SELECT = `SELECT om.organization_id, om.user_id, om.role, om.joined_at, u.name, u.email
  FROM org_memberships om JOIN users u ON u.id = om.user_id`;

export const ORG_EVENT_SELECT = `SELECT e.*, u.name AS actor_name, u.deactivated_at AS actor_deactivated_at
  FROM org_events e JOIN users u ON u.id = e.actor_id`;

export function serializeOrganization(org: OrganizationRow): Record<string, unknown> {
  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    plan: org.plan,
    limits: limitsOf(org.plan),
    owner_id: org.owner_id,
    version: org.version,
    created_at: iso(org.created_at),
    updated_at: iso(org.updated_at),
    deleted_at: isoOrNull(org.deleted_at),
  };
}

export function serializeOrgMember(row: OrgMemberRow): Record<string, unknown> {
  return { user: { id: row.user_id, name: row.name, email: row.email }, role: row.role, joined_at: iso(row.joined_at) };
}

export function loadOrgMember(db: DatabaseSync, organizationId: Id, userId: Id): OrgMemberRow | undefined {
  return one<OrgMemberRow>(db, `${ORG_MEMBER_SELECT} WHERE om.organization_id = ? AND om.user_id = ?`, organizationId, userId);
}

export function serializeOrgEvent(e: OrgEventWithActor): Record<string, unknown> {
  return {
    id: e.id,
    organization_id: e.organization_id,
    type: e.type,
    actor: actorRef({ id: e.actor_id, name: e.actor_name, deactivated_at: e.actor_deactivated_at }),
    target: { type: e.target_type, id: e.target_id },
    changes: JSON.parse(e.changes),
    occurred_at: iso(e.occurred_at),
  };
}
