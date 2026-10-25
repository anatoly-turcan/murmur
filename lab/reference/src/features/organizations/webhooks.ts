import { auditCreated } from '../../audit/record.ts';
import { randomBytes } from 'node:crypto';
import { all, one, run } from '../../db/sql.ts';
import { immediate } from '../../db/tx.ts';
import { assertLive } from '../../domain/load.ts';
import { assertOrgRole, loadOrganization, ORG_MANAGERS } from '../../domain/orgs.ts';
import type { WebhookRow } from '../../domain/rows.ts';
import { throwIfInvalid } from '../../http/errors.ts';
import { created, ok } from '../../http/respond.ts';
import type { Ctx, Result } from '../../http/types.ts';
import { validateBody } from '../../http/validate.ts';
import { ORG_WEBHOOK_CREATE_FIELDS } from '../webhooks/fields.ts';
import { serializeWebhook } from '../webhooks/serialize.ts';
import { newId } from '../../ids/uuid.ts';

export function createOrgWebhook(ctx: Ctx): Result {
  const { org, role } = loadOrganization(ctx, ctx.params.id);
  assertLive(org);
  assertOrgRole(role, ORG_MANAGERS);
  const { values, details } = validateBody(ctx.input().body, ORG_WEBHOOK_CREATE_FIELDS, { required: ['url', 'events'] });
  throwIfInvalid(details);
  const secret = values.secret ?? randomBytes(32).toString('hex');

  return immediate(ctx.db, () => {
    const id = newId(ctx.now);
    run(
      ctx.db,
      'INSERT INTO webhook_endpoints (id, organization_id, url, events, secret, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id,
      org.id,
      values.url!,
      JSON.stringify(values.events!),
      secret,
      ctx.now,
      ctx.now,
    );
    auditCreated(ctx.db, ctx.now, { type: 'webhook', id });

    return created(serializeWebhook(one<WebhookRow>(ctx.db, 'SELECT * FROM webhook_endpoints WHERE id = ?', id)!, true));
  });
}

export function listOrgWebhooks(ctx: Ctx): Result {
  const { org, role } = loadOrganization(ctx, ctx.params.id);
  assertLive(org);
  assertOrgRole(role, ORG_MANAGERS);
  const { limit, after } = ctx.page();
  const rows = all<WebhookRow>(
    ctx.db,
    'SELECT * FROM webhook_endpoints WHERE organization_id = ?1 AND (?2 IS NULL OR id > ?2) ORDER BY id LIMIT ?3',
    org.id,
    (after?.[0] as string | undefined) ?? null,
    limit + 1,
  );

  return ok(ctx.pageOf(rows, (r) => [r.id], (r) => serializeWebhook(r)));
}
