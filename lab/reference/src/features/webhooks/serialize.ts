import type { DatabaseSync } from 'node:sqlite';
import { all, placeholders } from '../../db/sql.ts';
import type { AttemptRow, DeliveryRow, WebhookRow } from '../../domain/rows.ts';
import { iso, isoOrNull } from '../../time/format.ts';
import type { Id } from '../../ids/uuid.ts';

export function serializeWebhook(w: WebhookRow, includeSecret = false): Record<string, unknown> {
  return {
    id: w.id,
    workspace_id: w.workspace_id,
    ...(w.organization_id !== null ? { organization_id: w.organization_id } : {}),
    url: w.url,
    events: JSON.parse(w.events),
    active: w.active === 1,
    ...(includeSecret ? { secret: w.secret } : {}),
    created_at: iso(w.created_at),
    updated_at: iso(w.updated_at),
  };
}

export function serializeAttempt(a: AttemptRow): Record<string, unknown> {
  return {
    number: a.number,
    started_at: iso(a.started_at),
    finished_at: isoOrNull(a.finished_at),
    outcome: a.outcome,
    status_code: a.status_code,
    error: a.error,
  };
}

export function serializeDelivery(d: DeliveryRow, attempts: AttemptRow[]): Record<string, unknown> {
  return {
    id: d.id,
    webhook_id: d.webhook_id,
    event: d.event,
    status: d.status,
    attempt_count: d.attempt_count,
    next_attempt_at: isoOrNull(d.next_attempt_at),
    attempts: attempts.map(serializeAttempt),
    payload: JSON.parse(d.payload),
    created_at: iso(d.created_at),
    completed_at: isoOrNull(d.completed_at),
  };
}

export function attemptsByDelivery(db: DatabaseSync, deliveryIds: Id[]): Map<Id, AttemptRow[]> {
  const out = new Map<Id, AttemptRow[]>(deliveryIds.map((id) => [id, []]));
  if (deliveryIds.length === 0) return out;
  const rows = all<AttemptRow>(
    db,
    `SELECT * FROM webhook_attempts WHERE delivery_id IN (${placeholders(deliveryIds.length)}) ORDER BY delivery_id, number`,
    ...deliveryIds,
  );
  for (const row of rows) out.get(row.delivery_id)?.push(row);

  return out;
}

export function serializeDeliveries(db: DatabaseSync, deliveries: DeliveryRow[]): Record<string, unknown>[] {
  const attempts = attemptsByDelivery(db, deliveries.map((d) => d.id));

  return deliveries.map((d) => serializeDelivery(d, attempts.get(d.id) ?? []));
}
