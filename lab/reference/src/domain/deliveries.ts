import type { DatabaseSync } from 'node:sqlite';
import { run } from '../db/sql.ts';
import type { Id } from '../ids/uuid.ts';

const OPEN = `status IN ('pending', 'in_progress')`;

export function cancelOpenDeliveries(db: DatabaseSync, workspaceId: Id, now: number): number {
  run(
    db,
    `UPDATE jobs SET status = 'succeeded', last_error = 'cancelled', updated_at = ?
      WHERE status = 'pending' AND id IN (SELECT job_id FROM webhook_deliveries WHERE workspace_id = ? AND ${OPEN})`,
    now,
    workspaceId,
  );

  return run(
    db,
    `UPDATE webhook_deliveries SET status = 'cancelled', completed_at = ?, next_attempt_at = NULL WHERE workspace_id = ? AND ${OPEN}`,
    now,
    workspaceId,
  );
}

export function deleteEndpointDeliveries(db: DatabaseSync, webhookId: Id): void {
  run(db, 'DELETE FROM webhook_attempts WHERE delivery_id IN (SELECT id FROM webhook_deliveries WHERE webhook_id = ?)', webhookId);
  run(db, 'DELETE FROM jobs WHERE id IN (SELECT job_id FROM webhook_deliveries WHERE webhook_id = ?)', webhookId);
  run(db, 'DELETE FROM webhook_deliveries WHERE webhook_id = ?', webhookId);
}

export function cancelOrganizationDeliveries(db: DatabaseSync, organizationId: Id, now: number): number {
  const endpoints = 'SELECT id FROM webhook_endpoints WHERE organization_id = ?';
  run(
    db,
    `UPDATE jobs SET status = 'succeeded', last_error = 'cancelled', updated_at = ?
      WHERE status = 'pending' AND id IN (SELECT job_id FROM webhook_deliveries WHERE webhook_id IN (${endpoints}) AND ${OPEN})`,
    now,
    organizationId,
  );

  return run(
    db,
    `UPDATE webhook_deliveries SET status = 'cancelled', completed_at = ?, next_attempt_at = NULL WHERE webhook_id IN (${endpoints}) AND ${OPEN}`,
    now,
    organizationId,
  );
}
