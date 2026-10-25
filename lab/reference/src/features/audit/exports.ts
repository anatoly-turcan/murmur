import type { DatabaseSync } from 'node:sqlite';
import { auditCreated } from '../../audit/record.ts';
import { all, one, run, scalar } from '../../db/sql.ts';
import { immediate } from '../../db/tx.ts';
import { enqueueEmail } from '../../domain/emails.ts';
import { assertLive } from '../../domain/load.ts';
import { assertOrgRole, loadOrganization, PLAN_MANAGERS } from '../../domain/orgs.ts';
import { ApiError, conflict, detail, notFound, throwIfInvalid } from '../../http/errors.ts';
import { accepted } from '../../http/respond.ts';
import type { Ctx, Result } from '../../http/types.ts';
import { custom, INVALID, validateBody } from '../../http/validate.ts';
import { isOwned } from '../../jobs/claim.ts';
import { enqueue } from '../../jobs/queue.ts';
import { jobPayload, succeeded, type JobContext, type JobHandler, type JobRow } from '../../jobs/types.ts';
import { iso, parseTimestamp } from '../../time/format.ts';
import { newId, type Id } from '../../ids/uuid.ts';
import { serializeExport, type ExportRow } from './export-row.ts';
import { serializeEntry, type AuditRow } from './serialize.ts';

const MAX_EXPORT_ENTRIES = 1_000_000;
const CHUNK_ENTRIES = 2_000;
const NDJSON = 'application/x-ndjson';

const timestamp = custom<number>((value, path, details) => {
  const ms = typeof value === 'string' ? parseTimestamp(value) : null;
  if (ms !== null) return ms;
  details.push({ path, code: typeof value === 'string' ? 'invalid_format' : 'invalid_type' });

  return INVALID;
});

const EXPORT_FIELDS = { since: timestamp, until: timestamp };

interface Range {
  since: number;
  until: number;
}

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

function exportRange(ctx: Ctx): Range {
  const { values, details } = validateBody(ctx.input().body, EXPORT_FIELDS, { required: ['since', 'until'] });
  if (values.since !== undefined && values.until !== undefined && values.since >= values.until) {
    details.push(detail('until', 'invalid_range', { message: 'until must be later than since.' }));
  }
  throwIfInvalid(details);

  return { since: values.since!, until: values.until! };
}

function entriesInRange(db: DatabaseSync, organizationId: Id, range: Range): number {
  return (
    scalar<number>(
      db,
      `SELECT count(*) FROM (SELECT 1 FROM audit_entries WHERE organization_id = ? AND occurred_at >= ? AND occurred_at < ? LIMIT ?)`,
      organizationId,
      range.since,
      range.until,
      MAX_EXPORT_ENTRIES + 1,
    ) ?? 0
  );
}

function insertExport(db: DatabaseSync, organizationId: Id, requestedBy: Id, range: Range, now: number): ExportRow {
  const id = newId(now);
  run(
    db,
    `INSERT INTO audit_exports (id, organization_id, requested_by, since, until, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
    id,
    organizationId,
    requestedBy,
    range.since,
    range.until,
    now,
  );
  enqueue(db, { type: 'audit_export', payload: { export_id: id }, runAt: now, now });

  return one<ExportRow>(db, 'SELECT * FROM audit_exports WHERE id = ?', id)!;
}

export function requestExport(ctx: Ctx): Result {
  const { org, role } = loadOrganization(ctx, ctx.params.id);
  assertLive(org);
  assertOrgRole(role, PLAN_MANAGERS);
  const range = exportRange(ctx);
  if (entriesInRange(ctx.db, org.id, range) > MAX_EXPORT_ENTRIES) {
    throw new ApiError(422, 'export_too_large', `An export may cover at most ${MAX_EXPORT_ENTRIES} entries.`);
  }

  return immediate(ctx.db, () => {
    const row = insertExport(ctx.db, org.id, ctx.me().id, range, ctx.now);
    auditCreated(ctx.db, ctx.now, { type: 'audit_export', id: row.id });

    return accepted(serializeExport(row));
  });
}

function* exportChunks(db: DatabaseSync, exportId: Id): Generator<string> {
  for (let seq = 0; ; seq += 1) {
    const chunk = one<{ content: string }>(db, 'SELECT content FROM audit_export_chunks WHERE export_id = ? AND seq = ?', exportId, seq);
    if (!chunk) return;
    yield chunk.content;
  }
}

export function downloadExport(ctx: Ctx): Result {
  const { org, role } = loadOrganization(ctx, ctx.params.id);
  assertOrgRole(role, PLAN_MANAGERS);
  ctx.input();
  const row = one<ExportRow>(ctx.db, 'SELECT * FROM audit_exports WHERE id = ? AND organization_id = ?', ctx.params.export_id, org.id);
  if (!row) throw notFound();
  if (row.status !== 'ready') throw conflict('export_not_ready', 'The export is still being prepared.');

  return { status: 200, stream: { contentType: NDJSON, chunks: exportChunks(ctx.db, row.id) } };
}

function pageAfter(db: DatabaseSync, exp: ExportRow, after: AuditRow | null): AuditRow[] {
  return all<AuditRow>(
    db,
    `SELECT * FROM audit_entries WHERE organization_id = ?1 AND occurred_at >= ?2 AND occurred_at < ?3
        AND (?4 IS NULL OR occurred_at > ?4 OR (occurred_at = ?4 AND id > ?5))
      ORDER BY occurred_at, id LIMIT ?6`,
    exp.organization_id,
    exp.since,
    exp.until,
    after?.occurred_at ?? null,
    after?.id ?? null,
    CHUNK_ENTRIES,
  );
}

function ndjson(rows: AuditRow[]): string {
  return rows.map((r) => `${JSON.stringify(serializeEntry(r))}\n`).join('');
}

function ownedWrite(job: JobRow, ctx: JobContext, write: () => void): void {
  ctx.begin(() => {
    if (!isOwned(ctx.db, job.id, ctx.workerId)) throw new Error(`audit export job ${job.id} is no longer owned by this worker`);
    write();
  });
}

async function writeChunks(job: JobRow, ctx: JobContext, exp: ExportRow): Promise<number> {
  ownedWrite(job, ctx, () => run(ctx.db, 'DELETE FROM audit_export_chunks WHERE export_id = ?', exp.id));
  let count = 0;
  let after: AuditRow | null = null;
  for (let seq = 0; ; seq += 1) {
    const rows = pageAfter(ctx.db, exp, after);
    if (rows.length === 0) return count;
    ownedWrite(job, ctx, () => run(ctx.db, 'INSERT INTO audit_export_chunks (export_id, seq, content) VALUES (?, ?, ?)', exp.id, seq, ndjson(rows)));
    count += rows.length;
    after = rows[rows.length - 1];
    await yieldToEventLoop();
  }
}

function finishExport(db: DatabaseSync, exp: ExportRow, count: number, now: number): void {
  const changed = run(
    db,
    `UPDATE audit_exports SET status = 'ready', entry_count = ?, completed_at = ? WHERE id = ? AND status = 'pending'`,
    count,
    now,
    exp.id,
  );
  if (changed === 0) return;
  enqueueEmail(db, now, {
    template: 'audit_export_ready',
    toUserId: exp.requested_by,
    subject: 'Your audit log export is ready',
    dedupeKey: `audit_export_ready:${exp.id}`,
    data: { export_id: exp.id, organization_id: exp.organization_id, entries: count, since: iso(exp.since), until: iso(exp.until) },
  });
}

export const auditExportJob: JobHandler = {
  async run(job, ctx) {
    const { export_id: exportId } = jobPayload<{ export_id: Id }>(job);
    const exp = one<ExportRow>(ctx.db, 'SELECT * FROM audit_exports WHERE id = ?', exportId);
    if (!exp || exp.status === 'ready') return succeeded();
    const count = await writeChunks(job, ctx, exp);

    return succeeded({ apply: () => finishExport(ctx.db, exp, count, ctx.now()) });
  },
};
