import type { DatabaseSync } from 'node:sqlite';
import { audited } from '../../audit/record.ts';
import { one, run } from '../../db/sql.ts';
import { immediate } from '../../db/tx.ts';
import { recordEvent, type Changes } from '../../domain/events.ts';
import { assertLive, assertRole, loadWebhook } from '../../domain/load.ts';
import type { WebhookRow } from '../../domain/rows.ts';
import { throwIfInvalid } from '../../http/errors.ts';
import { ok } from '../../http/respond.ts';
import type { Ctx, Result } from '../../http/types.ts';
import { validateBody, type ValuesOf } from '../../http/validate.ts';
import { ORG_WEBHOOK_PATCH_FIELDS, WEBHOOK_PATCH_FIELDS } from './fields.ts';
import { serializeWebhook } from './serialize.ts';
import type { Id } from '../../ids/uuid.ts';

type Patch = ValuesOf<typeof WEBHOOK_PATCH_FIELDS>;

interface WebhookState {
  url: string;
  events: string[];
  active: boolean;
}

function stateOf(row: WebhookRow): WebhookState {
  return { url: row.url, events: JSON.parse(row.events) as string[], active: row.active === 1 };
}

function changesBetween(before: WebhookState, after: WebhookState): Changes {
  const changes: Changes = {};
  for (const key of ['url', 'events', 'active'] as const) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) changes[key] = { from: before[key], to: after[key] };
  }

  return changes;
}

function saveWebhook(db: DatabaseSync, id: Id, state: WebhookState, now: number): WebhookRow {
  run(
    db,
    'UPDATE webhook_endpoints SET url = ?, events = ?, active = ?, updated_at = ? WHERE id = ?',
    state.url,
    JSON.stringify(state.events),
    state.active ? 1 : 0,
    now,
    id,
  );

  return one<WebhookRow>(db, 'SELECT * FROM webhook_endpoints WHERE id = ?', id)!;
}

function applyPatch(before: WebhookState, patch: Patch): WebhookState {
  return { url: patch.url ?? before.url, events: patch.events ?? before.events, active: patch.active ?? before.active };
}

export function updateWebhook(ctx: Ctx): Result {
  const { parent, webhook, role } = loadWebhook(ctx, ctx.params.id);
  assertLive(parent);
  assertRole(role, 'admin');
  const { values, details } = validateBody(ctx.input().body, webhook.workspace_id === null ? ORG_WEBHOOK_PATCH_FIELDS : WEBHOOK_PATCH_FIELDS, {});
  throwIfInvalid(details);
  const before = stateOf(webhook);
  const after = applyPatch(before, values);

  return immediate(ctx.db, () => {
    const saved = audited(ctx.db, ctx.now, { type: 'webhook', id: webhook.id }, 'update', () => saveWebhook(ctx.db, webhook.id, after, ctx.now));
    if (webhook.workspace_id !== null) {
      recordEvent(ctx.db, ctx.now, ctx.me(), {
        workspaceId: webhook.workspace_id,
        type: 'webhook.updated',
        target: { type: 'webhook', id: webhook.id },
        changes: changesBetween(before, after),
      });
    }

    return ok(serializeWebhook(saved));
  });
}
