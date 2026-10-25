import { all, scalar } from '../../db/sql.ts';
import { immediate } from '../../db/tx.ts';
import { ApiError, badRequest, conflict, throwIfInvalid } from '../../http/errors.ts';
import { noContent, ok } from '../../http/respond.ts';
import { q } from '../../http/query.ts';
import type { Ctx, Route } from '../../http/types.ts';
import { custom, int, INVALID, validateBody } from '../../http/validate.ts';
import { emailRecord, type OutboxRow } from '../../jobs/email-job.ts';
import { JOB_STATUSES, type JobRow } from '../../jobs/types.ts';
import { runSchedulerEvaluation } from '../../scheduler/scheduler.ts';
import type { SchedulerRule, Slice } from '../../slices/types.ts';
import { appNow, readOverride, setOverride } from '../../time/clock.ts';
import { iso, parseTimestamp } from '../../time/format.ts';
import { drainJobs } from './drain.ts';
import { resetDatabase } from './reset.ts';

export interface TestingDeps {
  rules: readonly SchedulerRule[];
  seed: Slice['seed'];
}

const base = { auth: 'none', rateLimit: false } as const;

const timestampField = custom<number>((value, path, details) => {
  const ms = typeof value === 'string' ? parseTimestamp(value) : null;
  if (ms !== null) return ms;
  details.push({ path, code: typeof value === 'string' ? 'invalid_format' : 'invalid_type' });

  return INVALID;
});

function clockBody(ctx: Ctx): { now: string; overridden: boolean } {
  const override = readOverride(ctx.db);

  return { now: iso(override ?? Date.now()), overridden: override !== null };
}

function jobItem(job: JobRow): Record<string, unknown> {
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    attempt_count: job.attempt_count,
    run_at: iso(job.run_at),
    last_error: job.last_error,
  };
}

function emailFilters(query: Record<string, unknown>): { where: string; params: string[] } {
  const clauses: string[] = [];
  const params: string[] = [];
  for (const [name, column] of [['to', 'to_email'], ['template', 'template'], ['dedupe_key', 'dedupe_key']] as const) {
    const value = query[name] as string | undefined;
    if (value === undefined || value === '') continue;
    clauses.push(`${column} = ?`);
    params.push(value);
  }

  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

function setClock(ctx: Ctx) {
  const { values, details } = validateBody(ctx.input().body, { now: timestampField }, { required: ['now'] });
  throwIfInvalid(details);
  setOverride(ctx.db, values.now!);

  return ok(clockBody(ctx));
}

function advanceClock(ctx: Ctx) {
  const { values, details } = validateBody(ctx.input().body, { seconds: int({ min: 0, max: Number.MAX_SAFE_INTEGER }) }, { required: ['seconds'] });
  throwIfInvalid(details);
  const current = readOverride(ctx.db);
  if (current === null) throw badRequest('clock_not_overridden', 'The clock is not overridden.');
  setOverride(ctx.db, current + values.seconds! * 1000);

  return ok(clockBody(ctx));
}

function reset(ctx: Ctx) {
  resetDatabase(ctx.db);

  return noContent();
}

function clearClock(ctx: Ctx) {
  setOverride(ctx.db, null);

  return noContent();
}

function clearEmails(ctx: Ctx) {
  immediate(ctx.db, () => ctx.db.exec('DELETE FROM outbox_emails'));

  return noContent();
}

function seed(ctx: Ctx, deps: TestingDeps) {
  ctx.input();
  if ((scalar<number>(ctx.db, 'SELECT count(*) FROM users') ?? 0) > 0) {
    throw conflict('database_not_empty', 'The database must be empty before seeding.');
  }
  if (!deps.seed) throw new ApiError(501, 'not_implemented', 'No seeder is registered.');

  return ok(deps.seed(ctx.db, ctx.now));
}

export function testingRoutes(deps: TestingDeps): Route[] {
  return [
    { ...base, method: 'POST', path: '/__test/reset', body: 'none', handle: reset },
    { ...base, method: 'GET', path: '/__test/clock', handle: (ctx) => ok(clockBody(ctx)) },
    { ...base, method: 'PUT', path: '/__test/clock', handle: setClock },
    { ...base, method: 'DELETE', path: '/__test/clock', handle: clearClock },
    { ...base, method: 'POST', path: '/__test/clock/advance', handle: advanceClock },
    {
      ...base,
      method: 'POST',
      path: '/__test/scheduler/tick',
      body: 'none',
      handle: (ctx) => ok(runSchedulerEvaluation(ctx.db, appNow(ctx.db, true), deps.rules, true)),
    },
    {
      ...base,
      method: 'POST',
      path: '/__test/jobs/drain',
      body: 'none',
      handle: async (ctx) => ok(await drainJobs(ctx.db, () => appNow(ctx.db, true))),
    },
    {
      ...base,
      method: 'GET',
      path: '/__test/jobs',
      query: { status: q.enumOne(JOB_STATUSES) },
      handle(ctx) {
        const status = ctx.input().query.status as string | undefined;
        const rows = status
          ? all<JobRow>(ctx.db, 'SELECT * FROM jobs WHERE status = ? ORDER BY id DESC LIMIT 1000', status)
          : all<JobRow>(ctx.db, 'SELECT * FROM jobs ORDER BY id DESC LIMIT 1000');

        return ok({ data: rows.map(jobItem) });
      },
    },
    {
      ...base,
      method: 'GET',
      path: '/__test/emails',
      query: { to: q.raw(), template: q.raw(), dedupe_key: q.raw() },
      handle(ctx) {
        const { where, params } = emailFilters(ctx.input().query);
        const rows = all<OutboxRow>(ctx.db, `SELECT * FROM outbox_emails ${where} ORDER BY sent_at, id`, ...params);

        return ok({ data: rows.map(emailRecord) });
      },
    },
    {
      ...base,
      method: 'DELETE',
      path: '/__test/emails',
      handle: clearEmails,
    },
    { ...base, method: 'POST', path: '/__test/seed', handle: (ctx) => seed(ctx, deps) },
  ];
}
