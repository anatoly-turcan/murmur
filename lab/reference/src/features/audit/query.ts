import { all, type SqlValue } from '../../db/sql.ts';
import { AUDIT_ACTIONS } from '../../audit/record.ts';
import { RESOURCE_TYPES } from '../../audit/snapshots.ts';
import { LEGACY_KINDS } from '../../ids/legacy.ts';
import { idListParam, q, type QuerySpec, type QueryValues } from '../../http/query.ts';
import type { Ctx, PageBody } from '../../http/types.ts';
import { serializeEntry, type AuditRow } from './serialize.ts';

export const AUDIT_QUERY: QuerySpec = {
  actor_id: q.id('user'),
  resource_type: q.enumOne(RESOURCE_TYPES),
  resource_id: q.id(...LEGACY_KINDS),
  action: q.enumOne(AUDIT_ACTIONS),
  since: q.timestamp(),
  until: q.timestamp(),
  request_id: q.raw(),
};

export interface AuditScope {
  where: string;
  params: SqlValue[];
}

interface Clause {
  sql: string;
  value: SqlValue | undefined;
}

function filterClauses(query: QueryValues): Clause[] {
  return [
    { sql: 'a.actor_id = ?', value: query.actor_id as string | undefined },
    { sql: 'a.resource_type = ?', value: query.resource_type as string | undefined },
    { sql: 'a.resource_id IN (SELECT value FROM json_each(?))', value: idListParam(query.resource_id) ?? undefined },
    { sql: 'a.action = ?', value: query.action as string | undefined },
    { sql: 'a.occurred_at >= ?', value: query.since as number | undefined },
    { sql: 'a.occurred_at < ?', value: query.until as number | undefined },
    { sql: 'a.request_id = ?', value: query.request_id as string | undefined },
  ].filter((c) => c.value !== undefined);
}

function keyset(after: unknown[] | null): { sql: string[]; params: SqlValue[] } {
  if (!after) return { sql: [], params: [] };
  const [occurredAt, id] = after as [number, string];

  return { sql: ['(a.occurred_at < ? OR (a.occurred_at = ? AND a.id < ?))'], params: [occurredAt, occurredAt, id] };
}

export function listAudit(ctx: Ctx, scope: AuditScope): PageBody<Record<string, unknown>> {
  const { limit, after } = ctx.page();
  const filters = filterClauses(ctx.input().query);
  const page = keyset(after);
  const where = [scope.where, ...filters.map((c) => c.sql), ...page.sql].join(' AND ');
  const rows = all<AuditRow>(
    ctx.db,
    `SELECT * FROM audit_entries a WHERE ${where} ORDER BY a.occurred_at DESC, a.id DESC LIMIT ?`,
    ...scope.params,
    ...filters.map((c) => c.value as SqlValue),
    ...page.params,
    limit + 1,
  );

  return ctx.pageOf(rows, (r) => [r.occurred_at, r.id], serializeEntry);
}
