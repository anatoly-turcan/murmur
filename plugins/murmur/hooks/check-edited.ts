#!/usr/bin/env node
import { text } from 'node:stream/consumers';

import { markSeen, repoTop } from './src/changes.ts';
import { settled } from './src/debounce.ts';
import { hookEvent, hookOptions, type HookEvent } from './src/input.ts';
import { checkReports, postToolUseOutput, writeOutput } from './src/summary.ts';
import { editTarget, type Target } from './src/target.ts';

function markChecked(event: HookEvent, target: Target): void {
  const top = repoTop(target.root);
  if (top !== null) {
    markSeen(top, event.session, [target.file]);
  }
}

async function main(): Promise<void> {
  const options = hookOptions(process.argv.slice(2));
  const event = hookEvent(await text(process.stdin));
  const target = event?.filePath == null ? null : editTarget(event.filePath);

  if (event === null || target === null || !(await settled(target, options.debounceMs))) {
    return;
  }

  writeOutput(postToolUseOutput(checkReports([target])));
  markChecked(event, target);
}

await main();
