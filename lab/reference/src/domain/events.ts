import type { DatabaseSync } from 'node:sqlite';
import { all, run } from '../db/sql.ts';
import { withLegacyIds } from '../ids/payload.ts';
import { enqueue } from '../jobs/queue.ts';
import { iso } from '../time/format.ts';
import { actorRef } from './actor.ts';
import type { UserRow } from './rows.ts';
import { newId, type Id } from '../ids/uuid.ts';

export const ACTIVITY_TYPES = [
  'workspace.created',
  'workspace.updated',
  'workspace.deleted',
  'workspace.restored',
  'member.added',
  'member.role_changed',
  'member.removed',
  'ownership.transferred',
  'project.created',
  'project.updated',
  'project.deleted',
  'project.restored',
  'task.created',
  'task.updated',
  'task.deleted',
  'task.restored',
  'comment.created',
  'comment.updated',
  'comment.deleted',
  'comment.restored',
  'webhook.created',
  'webhook.updated',
  'webhook.deleted',
] as const;

export const WEBHOOK_EVENTS = [
  'task.created',
  'task.updated',
  'task.deleted',
  'task.restored',
  'comment.created',
  'comment.updated',
  'comment.deleted',
  'project.created',
  'project.updated',
  'project.deleted',
  'project.restored',
  'member.added',
  'member.removed',
] as const;

export const TARGET_TYPES = ['workspace', 'member', 'project', 'task', 'comment', 'webhook'] as const;

export type ActivityType = (typeof ACTIVITY_TYPES)[number];
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];
export type TargetType = (typeof TARGET_TYPES)[number];
export type Changes = Record<string, { from: unknown; to: unknown }>;

export interface EventInput {
  workspaceId: Id;
  type: ActivityType;
  target: { type: TargetType; id: Id };
  changes?: Changes;
  data?: Record<string, unknown>;
}

interface EndpointRow {
  id: Id;
  events: string;
}

export function isWebhookEvent(type: string): type is WebhookEvent {
  return (WEBHOOK_EVENTS as readonly string[]).includes(type);
}

export function subscribes(events: readonly string[], type: string): boolean {
  return isWebhookEvent(type) && (events.includes('*') || events.includes(type));
}

function subscribedEndpoints(db: DatabaseSync, workspaceId: Id, type: string): EndpointRow[] {
  return all<EndpointRow>(db, 'SELECT id, events FROM webhook_endpoints WHERE workspace_id = ? AND active = 1 ORDER BY id', workspaceId).filter(
    (e) => subscribes(JSON.parse(e.events) as string[], type),
  );
}

export interface DeliveryTarget {
  endpointId: Id;
  workspaceId: Id | null;
  eventId: Id;
}

export function createDelivery(db: DatabaseSync, target: DeliveryTarget, envelope: Record<string, unknown>, now: number): Id {
  const deliveryId = newId(now);
  run(
    db,
    `INSERT INTO webhook_deliveries (id, webhook_id, workspace_id, activity_event_id, event, payload, status, job_id, created_at)
     VALUES (?, ?, ?, ?, ?, '', 'pending', 0, ?)`,
    deliveryId,
    target.endpointId,
    target.workspaceId,
    target.eventId,
    envelope.event as string,
    now,
  );
  const payload = JSON.stringify(withLegacyIds(db, now, { delivery_id: deliveryId, ...envelope }));
  const job = enqueue(db, { type: 'webhook_delivery', payload: { delivery_id: deliveryId }, runAt: now, now, queueKey: `webhook:${target.endpointId}` });
  run(db, 'UPDATE webhook_deliveries SET payload = ?, job_id = ?, next_attempt_at = ? WHERE id = ?', payload, job.id, job.runAt, deliveryId);

  return deliveryId;
}

interface OrgEndpointRow extends EndpointRow {
  organization_id: Id;
}

function organizationEndpoints(db: DatabaseSync, workspaceId: Id): OrgEndpointRow[] {
  return all<OrgEndpointRow>(
    db,
    `SELECT e.id, e.events, e.organization_id FROM webhook_endpoints e
       JOIN workspaces w ON w.organization_id = e.organization_id
      WHERE w.id = ? AND e.active = 1 ORDER BY e.id`,
    workspaceId,
  ).filter((e) => (JSON.parse(e.events) as string[]).includes('*'));
}

function fanOut(db: DatabaseSync, eventId: Id, now: number, actor: UserRow, input: EventInput): void {
  const envelope = {
    event: input.type,
    occurred_at: iso(now),
    workspace_id: input.workspaceId,
    actor: actorRef(actor),
    data: input.data ?? {},
  };
  const target = { workspaceId: input.workspaceId, eventId };
  for (const endpoint of subscribedEndpoints(db, input.workspaceId, input.type)) {
    createDelivery(db, { ...target, endpointId: endpoint.id }, envelope, now);
  }
  for (const endpoint of organizationEndpoints(db, input.workspaceId)) {
    createDelivery(db, { ...target, endpointId: endpoint.id }, { ...envelope, organization_id: endpoint.organization_id }, now);
  }
}

export function recordEvent(db: DatabaseSync, now: number, actor: UserRow, input: EventInput): Id {
  const eventId = newId(now);
  run(
    db,
    `INSERT INTO activity_events (id, workspace_id, type, actor_id, target_type, target_id, changes, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    eventId,
    input.workspaceId,
    input.type,
    actor.id,
    input.target.type,
    input.target.id,
    JSON.stringify(input.changes ?? {}),
    now,
  );
  if (isWebhookEvent(input.type)) fanOut(db, eventId, now, actor, input);

  return eventId;
}
