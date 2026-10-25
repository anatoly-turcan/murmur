import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import type { Frame } from '@murmur/dev-protocol';

import { copyFixtureApp, openEvents, startDev } from './dev-helpers.ts';
import { writeFiles } from './helpers.ts';

type FrameOf<K extends Frame['frame']> = Extract<Frame, { frame: K }>;

const is =
  <K extends Frame['frame']>(kind: K) =>
  (frame: Frame): frame is FrameOf<K> =>
    frame.frame === kind;

function boomPiece(initialiser: string): string {
  return [
    "import { Handle, Piece } from 'murmur'",
    '',
    "import { Detonate } from '#contracts/boom'",
    '',
    'function connect(): boolean {',
    `  ${initialiser}`,
    '}',
    '',
    'export class Boom extends Piece() {',
    '  private readonly ledger = connect()',
    '',
    '  @Handle(Detonate)',
    '  async detonate(): Promise<{ ok: boolean }> {',
    '    return { ok: this.ledger }',
    '  }',
    '}',
    '',
  ].join('\n');
}

const BOOM_FILES = {
  'contracts/boom.ts': [
    "import { Query } from 'murmur'",
    "import { z } from 'zod'",
    '',
    'export class Detonate extends Query({}, { ok: z.boolean() }) {}',
    '',
  ].join('\n'),
  'pieces/boom/context.md': '---\nsummary: Throws while it is constructed.\n---\n\n# boom\n',
  'pieces/boom/piece.ts': boomPiece("throw new Error('cannot reach the ledger')"),
};

test(
  'a class piece whose field initialiser throws reports phase construct and dev keeps watching',
  { timeout: 120_000 },
  async (t) => {
    using app = copyFixtureApp();
    writeFiles(app.root, BOOM_FILES);
    const dev = await startDev(app.root);
    t.after(() => dev.child.kill('SIGKILL'));
    const events = await openEvents(`${dev.base}/api/events`);
    t.after(() => events.close());

    const failed = await events.next(is('dev.boot_failed'), 30_000);
    const [error] = failed.report.errors;

    assert.equal(error?.phase, 'construct', JSON.stringify(failed.report.errors));
    assert.equal(error?.piece, 'boom');
    assert.match(error?.message ?? '', /Boom could not be constructed: Error: cannot reach the ledger/);

    writeFileSync(join(app.root, 'pieces', 'boom', 'piece.ts'), boomPiece('return true'));
    const boot = await events.next(is('dev.boot'), 30_000);

    const names = boot.snapshot.pieces.map((piece) => `${piece.name}:${piece.status}`);

    assert.ok(names.includes('boom:running'), names.join(', '));
    dev.child.kill('SIGINT');
    assert.equal(await dev.exited, 0, dev.output());
  },
);
