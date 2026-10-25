import type { DatabaseSync } from 'node:sqlite';
import { all, run } from '../db/sql.ts';
import { iso } from '../time/format.ts';
import { actorRef } from './actor.ts';
import { createDelivery, type Changes } from './events.ts';
import type { UserRow } from './rows.ts';
import { newId, type Id } from '../ids/uuid.ts';

export const ORG_EVENT_TYPES = [
  'organization.created',
  'organization.updated',
  'organization.deleted',
  'organization.restored',
  'org_member.added',
  'org_member.removed',
  'org_member.role_changed',
  'plan.changed',
] as const;

export const ORG_TARGET_TYPES = ['organization', 'org_member'] as const;

export type OrgEventType = (typeof ORG_EVENT_TYPES)[number];

export interface OrgEventInput {
  organizationId: Id;
  type: OrgEventType;
  target: { type: (typeof ORG_TARGET_TYPES)[number]; id: Id };
  changes?: Changes;
  data?: Record<string, unknown>;
}

interface EndpointRow {
  id: Id;
  events: string;
}

function subscribedEndpoints(db: DatabaseSync, organizationId: Id, type: string): EndpointRow[] {
  return all<EndpointRow>(db, 'SELECT id, events FROM webhook_endpoints WHERE organization_id = ? AND active = 1 ORDER BY id', organizationId).filter(
    (e) => {
      const events = JSON.parse(e.events) as string[];

      return events.includes('*') || events.includes(type);
    },
  );
}

function fanOut(db: DatabaseSync, eventId: Id, now: number, actor: UserRow, input: OrgEventInput): void {
  const envelope = {
    event: input.type,
    occurred_at: iso(now),
    organization_id: input.organizationId,
    actor: actorRef(actor),
    data: { ...(input.data ?? {}), ...(input.changes ? { changes: input.changes } : {}) },
  };
  for (const endpoint of subscribedEndpoints(db, input.organizationId, input.type)) {
    createDelivery(db, { endpointId: endpoint.id, workspaceId: null, eventId }, envelope, now);
  }
}

export function recordOrgEvent(db: DatabaseSync, now: number, actor: UserRow, input: OrgEventInput): Id {
  const eventId = newId(now);
  run(
    db,
    `INSERT INTO org_events (id, organization_id, type, actor_id, target_type, target_id, changes, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    eventId,
    input.organizationId,
    input.type,
    actor.id,
    input.target.type,
    input.target.id,
    JSON.stringify(input.changes ?? {}),
    now,
  );
  fanOut(db, eventId, now, actor, input);

  return eventId;
}
