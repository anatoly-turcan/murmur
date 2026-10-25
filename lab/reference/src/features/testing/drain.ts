import type { DatabaseSync } from 'node:sqlite';
import { countDue, type DueCounts } from '../../jobs/claim.ts';

const POLL_MS = 25;
const LIMIT_MS = 30_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface DrainResult extends DueCounts {
  drained: boolean;
}

export async function drainJobs(db: DatabaseSync, now: () => number): Promise<DrainResult> {
  const deadline = Date.now() + LIMIT_MS;
  for (;;) {
    const counts = countDue(db, now());
    if (counts.pending === 0 && counts.running === 0) return { drained: true, ...counts };
    if (Date.now() >= deadline) return { drained: false, ...counts };
    await sleep(POLL_MS);
  }
}
