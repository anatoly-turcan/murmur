#!/usr/bin/env node
import { text } from 'node:stream/consumers';

import { inMurmurRepo, recordBaseline, repoTop } from './src/changes.ts';
import { hookEvent } from './src/input.ts';
import { context, writeOutput } from './src/summary.ts';

const USAGE_LINES = [
  'murmur: run `pnpm exec murmur ctx pieces/<id>` before editing a piece, then Read only the files it lists that the task touches.',
  'murmur: after editing, run `pnpm exec murmur check --fix pieces/<id>`, `pnpm exec murmur check pieces/<id>` and `pnpm exec murmur test pieces/<id>`.',
  'murmur: /murmur-piece writes a piece, /murmur-contract a contract, /murmur-review reviews changed pieces.',
] as const;

async function main(): Promise<void> {
  const event = hookEvent(await text(process.stdin));
  if (event === null) {
    return;
  }

  const top = repoTop(event.cwd);
  if (!inMurmurRepo(event.cwd, top)) {
    return;
  }

  if (top !== null) {
    recordBaseline(top, event.session);
  }

  writeOutput(context('SessionStart', USAGE_LINES.join('\n')));
}

await main();
