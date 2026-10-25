import type { ActorType } from '../../audit/context.ts';
import { iso } from '../../time/format.ts';
import type { Id } from '../../ids/uuid.ts';

export interface AuditRow {
  id: Id;
  occurred_at: number;
  actor_type: ActorType;
  actor_id: Id | null;
  actor_name: string;
  api_key_id: Id | null;
  ip: string | null;
  request_id: string | null;
  organization_id: Id | null;
  workspace_id: Id | null;
  resource_type: string;
  resource_id: Id;
  action: string;
  before: string | null;
  after: string | null;
  diff: string;
}

function parsed(text: string | null): unknown {
  return text === null ? null : JSON.parse(text);
}

export function serializeEntry(row: AuditRow): Record<string, unknown> {
  return {
    id: row.id,
    occurred_at: iso(row.occurred_at),
    actor: { type: row.actor_type, id: row.actor_id, name: row.actor_name },
    api_key_id: row.api_key_id,
    ip: row.ip,
    request_id: row.request_id,
    organization_id: row.organization_id,
    workspace_id: row.workspace_id,
    resource: { type: row.resource_type, id: row.resource_id },
    action: row.action,
    before: parsed(row.before),
    after: parsed(row.after),
    diff: JSON.parse(row.diff),
    idempotent_replay: false,
  };
}
