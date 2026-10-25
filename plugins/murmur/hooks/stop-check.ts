#!/usr/bin/env node
import { relative } from 'node:path';
import { text } from 'node:stream/consumers';

import { changedSinceBaseline, inMurmurRepo, repoTop } from './src/changes.ts';
import { hookEvent, type HookEvent } from './src/input.ts';
import { checkReports, stopOutput, writeOutput } from './src/summary.ts';
import { editTarget, type Target } from './src/target.ts';

function appTargets(event: HookEvent, top: string): Target[] {
  const changed = changedSinceBaseline(top, event.session).flatMap((file) => editTarget(file) ?? []);
  const roots = [...new Set(changed.map((target) => target.root))];

  return roots.map((root) => ({ root, file: root, key: relative(event.cwd, root) || '.' }));
}

async function main(): Promise<void> {
  const event = hookEvent(await text(process.stdin));
  const top = event === null ? null : repoTop(event.cwd);

  if (event === null || top === null || !inMurmurRepo(event.cwd, top)) {
    return;
  }

  writeOutput(stopOutput(checkReports(appTargets(event, top)), event.stopHookActive));
}

await main();
