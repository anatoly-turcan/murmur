import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { auditCreated } from '../audit/record.ts';
import { organizationOf, type Scope } from '../audit/snapshots.ts';
import { one, run } from '../db/sql.ts';
import { isMember } from '../domain/access.ts';
import type { EmailJobPayload } from '../domain/emails.ts';
import type { UserRow } from '../domain/rows.ts';
import { iso } from '../time/format.ts';
import { jobPayload, succeeded, type JobHandler, type JobRow } from './types.ts';
import { newId, type Id } from '../ids/uuid.ts';

export interface OutboxRow {
  id: Id;
  to_email: string;
  template: string;
  subject: string;
  dedupe_key: string;
  data: string;
  sent_at: number;
  sink_written: number;
}

export function emailRecord(row: OutboxRow): Record<string, unknown> {
  return {
    id: row.id,
    to: row.to_email,
    template: row.template,
    subject: row.subject,
    dedupe_key: row.dedupe_key,
    data: JSON.parse(row.data),
    sent_at: iso(row.sent_at),
  };
}

function recipient(db: DatabaseSync, p: EmailJobPayload): UserRow | null {
  const user = one<UserRow>(db, 'SELECT * FROM users WHERE id = ?', p.to_user_id);
  if (!user || user.deactivated_at !== null) return null;
  if (p.require_member_of !== null && !isMember(db, p.require_member_of, user.id)) return null;

  return user;
}

function insertOutbox(db: DatabaseSync, p: EmailJobPayload, to: string, now: number): OutboxRow | undefined {
  return one<OutboxRow>(
    db,
    `INSERT INTO outbox_emails (id, to_email, template, subject, dedupe_key, data, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (dedupe_key) DO NOTHING RETURNING *`,
    newId(now),
    to,
    p.template,
    p.subject,
    p.dedupe_key,
    JSON.stringify(p.data),
    now,
  );
}

function sinkHas(path: string, dedupeKey: string): boolean {
  if (!existsSync(path)) return false;
  const needle = `"dedupe_key":${JSON.stringify(dedupeKey)}`;

  return readFileSync(path, 'utf8').split('\n').some((line) => line.includes(needle));
}

function writeSink(db: DatabaseSync, path: string, row: OutboxRow, checkFirst: boolean): void {
  if (!checkFirst || !sinkHas(path, row.dedupe_key)) appendFileSync(path, `${JSON.stringify(emailRecord(row))}\n`);
  run(db, 'UPDATE outbox_emails SET sink_written = 1 WHERE id = ?', row.id);
}

function emailScope(db: DatabaseSync, p: EmailJobPayload): Scope {
  const named = (key: string) => (typeof p.data[key] === 'string' ? (p.data[key] as Id) : null);
  const workspaceId = p.require_member_of ?? named('workspace_id');

  return { workspaceId, organizationId: named('organization_id') ?? organizationOf(db, workspaceId) };
}

export function deliverEmail(db: DatabaseSync, p: EmailJobPayload, now: number, sinkPath: string | null): void {
  const user = recipient(db, p);
  if (!user) return;
  const row = insertOutbox(db, p, user.email, now);
  if (!row) return;
  auditCreated(db, now, { type: 'email', id: row.id, scope: emailScope(db, p) }, 'send');
  if (sinkPath) writeSink(db, sinkPath, row, p.check_sink === true);
}

function markCheckSink(db: DatabaseSync, job: JobRow): void {
  run(db, `UPDATE jobs SET payload = json_set(payload, '$.check_sink', json('true')) WHERE id = ?`, job.id);
}

export const emailJob: JobHandler = {
  async run(job, ctx) {
    const payload = jobPayload<EmailJobPayload>(job);

    return succeeded({ apply: () => deliverEmail(ctx.db, payload, ctx.now(), ctx.config.emailSinkPath) });
  },
  onInterrupted(db, job, now) {
    return { result: { status: 'retry', runAt: now, error: 'worker terminated' }, apply: () => markCheckSink(db, job) };
  },
};
