#!/usr/bin/env node
import { join } from 'node:path';
import { text } from 'node:stream/consumers';

import { changedSinceLastLook, inMurmurRepo, repoTop } from './src/changes.ts';
import { settled } from './src/debounce.ts';
import { hookEvent, hookOptions, type HookEvent } from './src/input.ts';
import { checkReports, postToolUseOutput, writeOutput } from './src/summary.ts';
import { editTarget, type Target, uniqueTargets } from './src/target.ts';

function changedTargets(event: HookEvent): Target[] {
  const top = repoTop(event.cwd);
  if (top === null || !inMurmurRepo(event.cwd, top)) {
    return [];
  }

  const targets = changedSinceLastLook(top, event.session).flatMap((file) => editTarget(file) ?? []);

  return uniqueTargets(targets).map((target) => ({ ...target, file: join(target.root, target.key) }));
}

async function settledTargets(targets: readonly Target[], debounceMs: number): Promise<Target[]> {
  const settledFlags = await Promise.all(targets.map((target) => settled(target, debounceMs)));

  return targets.filter((_, at) => settledFlags[at] === true);
}

async function main(): Promise<void> {
  const options = hookOptions(process.argv.slice(2));
  const event = hookEvent(await text(process.stdin));

  if (event === null) {
    return;
  }

  const targets = await settledTargets(changedTargets(event), options.debounceMs);
  writeOutput(postToolUseOutput(checkReports(targets)));
}

await main();
