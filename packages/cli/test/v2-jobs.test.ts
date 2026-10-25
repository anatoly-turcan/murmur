import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { Frame } from '@murmur/dev-protocol';

import { tailLine } from '../src/render/tail.ts';
import { murmur } from './helpers.ts';
import { check, found, piece, v2Copy } from './v2-helpers.ts';

const WORK_CONTRACTS = [
  "import { Command } from 'murmur';",
  "import { z } from 'zod';",
  '',
  'export class Deliver extends Command({ url: z.string() }, {}) {}',
  '',
  'export class SweepDue extends Command({ limit: z.number().default(10) }, {}) {}',
  '',
  'export class Ping extends Command({ id: z.string() }, {}) {}',
  '',
  'export class Batch extends Command({ ids: z.array(z.string().optional()) }, {}) {}',
  '',
  "export class Lazy extends Command({ at: z.string().optional().describe('when') }, {}) {}",
  '',
].join('\n');

const NOTIFIER = [
  "import { jobs } from '@murmur/node/capabilities';",
  "import { Handle, Piece } from 'murmur';",
  '',
  "import { TodoCreated } from '#contracts/todos';",
  "import { Deliver, SweepDue } from '#contracts/work';",
  '',
  'export class Notifier extends Piece({ needs: { queue: jobs } }) {',
  '  @Handle(TodoCreated)',
  '  async created(event: TodoCreated): Promise<void> {',
  '    await this.queue.enqueue(Deliver, { url: `/hooks/${event.id}` }, { dedupeKey: event.id });',
  '  }',
  '',
  "  @Handle(Deliver, { retry: { attempts: 3, after: ['30s', '5m'] } })",
  '  async deliver(): Promise<void> {}',
  '',
  "  @Handle(SweepDue, { every: '1m' })",
  '  async sweep(): Promise<void> {}',
  '}',
  '',
].join('\n');

function handleLine(options: { every?: string; contract?: string; retry?: string }): string {
  if (options.retry === undefined) {
    return `@Handle(${options.contract ?? 'SweepDue'}, { every: '${options.every ?? '1m'}' })`;
  }

  return `@Handle(${options.contract ?? 'Deliver'}, { retry: ${options.retry} })`;
}

function broken(options: { every?: string; contract?: string; retry?: string }): string {
  return [
    "import { Handle, Piece } from 'murmur';",
    '',
    "import { TodoCreated } from '#contracts/todos';",
    "import { Batch, Deliver, Lazy, Ping, SweepDue } from '#contracts/work';",
    '',
    'export class Broken extends Piece() {',
    `  ${handleLine(options)}`,
    '  async run(_input: Batch | Deliver | Lazy | Ping | SweepDue | TodoCreated): Promise<void> {}',
    '}',
    '',
  ].join('\n');
}

function messages(root: string, rule: string): string[] {
  return found(check(root).json, rule).map((f) => f.message);
}

describe('jobs in check, catalog and ctx', () => {
  test('a job piece checks clean; ctx shows the schedules lane, the jobs page and job rows', () => {
    using app = v2Copy({ 'contracts/work.ts': WORK_CONTRACTS, ...piece('notifier', NOTIFIER) });
    const result = check(app.root);
    const ctx = murmur(['ctx', 'notifier', '--cwd', app.root]);

    assert.deepEqual(
      result.json.findings.filter((f) => /^(every|retry)-/.test(f.rule)),
      [],
    );
    assert.equal(ctx.status, 0, ctx.stderr);
    assert.match(ctx.stdout, /^- schedules: `work\.SweepDue every 1m`$/m);
    assert.match(ctx.stdout, /^### queue \(jobs\)\n\n# jobs$/m);
    assert.match(
      ctx.stdout,
      /`await this\.jobs\.enqueue\(Deliver, \{ url \}, \{ runAt, dedupeKey, groupKey \}\)`/,
    );
    assert.match(ctx.stdout, /^\| work\.Deliver \| job \| notifier \| notifier \|$/m);
    assert.match(ctx.stdout, /^\| work\.SweepDue \| job \| \(every 1m\) \| notifier \|$/m);
    assert.match(
      ctx.stdout,
      /Durable or delayed work: `this\.jobs\.enqueue\(C, input, \{ runAt, dedupeKey, groupKey \}\)`/,
    );
  });

  test('every that is not a duration is every-format, naming the units', () => {
    using app = v2Copy({ 'contracts/work.ts': WORK_CONTRACTS, ...piece('broken', broken({ every: '90' })) });

    assert.deepEqual(messages(app.root, 'every-format'), [
      "`every: '90'` is not a duration; use `<n>s`, `<n>m`, `<n>h` or `<n>d`",
    ]);
  });

  test('every on a command with required input is every-input; an optional field is fine', () => {
    using app = v2Copy({
      'contracts/work.ts': WORK_CONTRACTS,
      ...piece('broken', broken({ contract: 'Ping' })),
    });
    using clean = v2Copy({ 'contracts/work.ts': WORK_CONTRACTS, ...piece('broken', broken({})) });

    assert.deepEqual(messages(app.root, 'every-input'), [
      '`@Handle(Ping, { every })`: Ping has required input fields; a scheduled command takes none',
    ]);
    assert.deepEqual(messages(clean.root, 'every-input'), []);
  });

  test('every-input reads only the outer call chain of a field', () => {
    using nested = v2Copy({
      'contracts/work.ts': WORK_CONTRACTS,
      ...piece('broken', broken({ contract: 'Batch' })),
    });
    using described = v2Copy({
      'contracts/work.ts': WORK_CONTRACTS,
      ...piece('broken', broken({ contract: 'Lazy' })),
    });

    assert.deepEqual(messages(nested.root, 'every-input'), [
      '`@Handle(Batch, { every })`: Batch has required input fields; a scheduled command takes none',
    ]);
    assert.deepEqual(messages(described.root, 'every-input'), []);
  });

  test('a retry ladder on an event handler is retry-ladder, with the decorator text', () => {
    using app = v2Copy({
      'contracts/work.ts': WORK_CONTRACTS,
      ...piece('broken', broken({ contract: 'TodoCreated', retry: '{ attempts: 3 }' })),
    });

    assert.deepEqual(messages(app.root, 'retry-ladder'), [
      '`@Handle(TodoCreated, { retry })`: TodoCreated is an event; a retry ladder applies to job Commands (policy.retry covers bus redelivery)',
    ]);
  });

  test('a retry ladder entry that is not a duration is retry-ladder', () => {
    using app = v2Copy({
      'contracts/work.ts': WORK_CONTRACTS,
      ...piece('broken', broken({ retry: "{ attempts: 3, after: ['30s', '5'] }" })),
    });

    assert.deepEqual(messages(app.root, 'retry-ladder'), [
      `\`retry.after\` entries must be durations like '30s'; got "5"`,
    ]);
  });
});

describe('murmur tail', () => {
  test('a job delivery prints as job <contract> → its handler', () => {
    const frame: Frame = {
      frame: 'env',
      seq: 1,
      ts: '2026-10-25T12:00:00.000Z',
      envelope: {
        id: 'j1',
        name: '$ingress.job',
        payload: { url: '/hooks/1', binding: 'work.Deliver' },
        traceId: 'abcd1234',
        hop: 0,
        ts: '2026-10-25T12:00:00.000Z',
        source: 'external:job',
      },
      meta: { internal: false, piece: 'external:job' },
    } as Frame;
    const line = tailLine(frame, {
      internal: false,
      failed: false,
      payload: false,
      handlers: (name) => (name === 'work.Deliver' ? ['notifier'] : []),
    });

    assert.match(line ?? '', /▸ job work\.Deliver\s+tr=abcd c=—\s+from job\s+→ notifier$/);
  });
});
