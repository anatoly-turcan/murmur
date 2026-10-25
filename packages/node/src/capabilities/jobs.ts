import {
  contractKind,
  defineCapability,
  MurmurError,
  parseWire,
  type CapabilityStart,
  type CommandClass,
  type IngressPort,
  type Schema,
} from 'murmur';
import { z } from 'zod';

import { ambientHolder } from './holder.ts';
import { createRunner, type Runner } from './jobs-runner.ts';
import { countJobs, insertJob, JOBS_SCHEMA } from './jobs-store.ts';
import { asDatabase } from './sqlite.ts';
import { callableToken } from './token.ts';
import type { EnqueueOptions, Jobs } from './types.ts';

export const jobsConfig = z.object({
  poll: z.boolean().default(true),
  pollMs: z.number().int().positive().default(500),
  concurrency: z.number().int().positive().default(8),
});

const JOBS_DOCS = `# jobs

Durable commands on the app database (\`murmur_jobs\`, \`murmur_schedules\`). The piece names the field
(\`needs: { jobs }\` → \`this.jobs\`). A job is a Command: \`class Deliver extends Command({ url: z.string() }, {})\`;
its handler may return nothing when the output accepts \`{}\`.

- \`await this.jobs.enqueue(Deliver, { url }, { runAt, dedupeKey, groupKey })\` → \`{ enqueued: true }\`. Inside
  \`this.db.transaction(fn)\` of the same delivery the row joins it: the job exists only if the write commits. Never a
  timer for durable or delayed work.
- \`runAt\` (\`Temporal.Instant\`, default now); \`dedupeKey\`: a second enqueue while a job with that key is pending is
  ignored (\`{ enqueued: false }\`), a running job may re-enqueue its own key; \`groupKey\`: jobs of one group run one at
  a time, in enqueue order.
- Every process that handles the command claims due jobs (\`pollMs\` 500, \`concurrency\` 8 per process; none in a
  \`defineApp({ processes: { api: { pieces, jobs: false } } })\` process) and runs the handler like any delivery:
  \`delivery.attempt\` is the job attempt, \`delivery.envelope.id\` is stable per job (key \`kv.once\` on it).
- A throw retries by \`@Handle(Deliver, { retry: { attempts: 6, after: ['30s', '2m', '10m'] } })\` (the last step
  repeats), else by the piece's \`policy.retry\`; after \`attempts\` the job is \`dead\` (kept in the table).
  \`NonRetryableError\` is dead at once; a returned \`reject(…)\` is a success. A claim older than the piece timeout
  is taken again.
- \`@Handle(SweepDue, { every: '1m' })\` (\`s\`, \`m\`, \`h\`, \`d\`; no cron): the command takes no required input; one
  process per window enqueues it, so it runs once across processes.
- Stop: claiming ends, in-flight jobs get the piece timeout, unfinished claims go back to pending.
- Tests: \`await testPiece(P)\` keeps the jobs on its faked sqlite (a rollback keeps none; \`t.enqueued(C)\`,
  \`await t.runJobs()\`); \`createTestApp()\` sets
  \`capabilities.jobs.poll: false\`, then \`await app.jobs.drain()\` runs every job due by the clock (schedules too)
  until none is left → \`{ ran, failed, dead }\`, for this process only; \`await jobs.counts()\` →
  \`{ pending, running, dead }\`.
`;

type JobsConfig = z.output<typeof jobsConfig>;

const runners = new WeakMap<object, Runner>();

function requireIngress(ingress: IngressPort | undefined): IngressPort {
  if (ingress === undefined) {
    throw new MurmurError(
      'the jobs capability needs the runtime ingress port (start it through createRuntime)',
      {
        code: 'jobs-no-ingress',
        retryable: false,
      },
    );
  }

  return ingress;
}

export function assertCommand(contract: CommandClass): void {
  if (contractKind(contract) !== 'command') {
    const name = String(Reflect.get(Object(contract), 'name'));

    throw new MurmurError(
      `jobs.enqueue(${name}): ${name} is not a Command; a job is a Command, e.g. class Notify extends Command({ id: z.string() }, {})`,
      { code: 'jobs-not-command', retryable: false },
    );
  }
}

async function startJobs(ctx: CapabilityStart<typeof jobsConfig>): Promise<Jobs> {
  const database = asDatabase(ctx.needs['sqlite']);
  const config: JobsConfig = ctx.config;
  await database.handle().exec(JOBS_SCHEMA);
  const sql = database.handle();
  const ambient = database.handleFor(ambientHolder);
  const runner = createRunner({
    sql,
    ingress: requireIngress(ctx.ingress),
    clock: ctx.clock,
    ids: ctx.ids,
    log: ctx.log,
    config,
    mode: ctx.mode,
  });

  const handle: Jobs = {
    enqueue: async (contract, input, options: EnqueueOptions = {}) => {
      assertCommand(contract);
      const value = await parseWire(contract.wireName, 'payload', contract.input as Schema, input);
      const now = ctx.clock.now().epochMilliseconds;

      const enqueued = await insertJob(ambient, {
        id: ctx.ids.uuid(),
        contract: contract.wireName,
        input: JSON.stringify(value),
        runAt: options.runAt?.epochMilliseconds ?? now,
        dedupeKey: options.dedupeKey ?? null,
        groupKey: options.groupKey ?? null,
        now,
      });

      return { enqueued };
    },
    drain: () => runner.drain(),
    counts: () => countJobs(sql),
  };
  runners.set(handle, runner);

  return handle;
}

async function stopJobs(handle: Jobs, signal: AbortSignal): Promise<void> {
  await runners.get(handle)?.stop(signal);
}

export const jobs = callableToken(
  defineCapability({
    name: 'jobs',
    needs: ['sqlite'],
    ingress: true,
    config: jobsConfig,
    docs: JOBS_DOCS,
    start: (ctx) => startJobs(ctx),
    stop: (handle, signal) => stopJobs(handle, signal),
    fake: async ({ needs, clock }) => (await import('../testing/fakes.ts')).fakeJobs(needs['sqlite'], clock),
  }),
);
