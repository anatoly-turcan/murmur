import { auditCreated } from '../../audit/record.ts';
import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { one, run } from '../../db/sql.ts';
import { immediate } from '../../db/tx.ts';
import { recordEvent } from '../../domain/events.ts';
import { assertWebhookCapacity } from '../../domain/plans.ts';
import { assertLive, assertRole, loadWorkspace } from '../../domain/load.ts';
import type { WebhookRow } from '../../domain/rows.ts';
import { throwIfInvalid } from '../../http/errors.ts';
import { created } from '../../http/respond.ts';
import type { Ctx, Result } from '../../http/types.ts';
import { validateBody } from '../../http/validate.ts';
import { WEBHOOK_CREATE_FIELDS } from './fields.ts';
import { serializeWebhook } from './serialize.ts';
import { newId, type Id } from '../../ids/uuid.ts';

interface NewWebhook {
  workspaceId: Id;
  url: string;
  events: string[];
  secret: string;
}

function insertWebhook(db: DatabaseSync, w: NewWebhook, now: number): WebhookRow {
  const id = newId(now);
  run(
    db,
    'INSERT INTO webhook_endpoints (id, workspace_id, url, events, secret, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    id,
    w.workspaceId,
    w.url,
    JSON.stringify(w.events),
    w.secret,
    now,
    now,
  );

  return one<WebhookRow>(db, 'SELECT * FROM webhook_endpoints WHERE id = ?', id)!;
}

export function createWebhook(ctx: Ctx): Result {
  const { workspace, role } = loadWorkspace(ctx, ctx.params.id);
  assertLive(workspace);
  assertRole(role, 'admin');
  const { values, details } = validateBody(ctx.input().body, WEBHOOK_CREATE_FIELDS, { required: ['url', 'events'] });
  throwIfInvalid(details);
  const secret = values.secret ?? randomBytes(32).toString('hex');

  return immediate(ctx.db, () => {
    assertWebhookCapacity(ctx.db, workspace.id);
    const hook = insertWebhook(ctx.db, { workspaceId: workspace.id, url: values.url!, events: values.events!, secret }, ctx.now);
    auditCreated(ctx.db, ctx.now, { type: 'webhook', id: hook.id });
    recordEvent(ctx.db, ctx.now, ctx.me(), { workspaceId: workspace.id, type: 'webhook.created', target: { type: 'webhook', id: hook.id } });

    return created(serializeWebhook(hook, true));
  });
}
