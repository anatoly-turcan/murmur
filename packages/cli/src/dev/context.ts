import type { Snapshot } from '@murmur/dev-protocol';

import type { Analysis } from '../analysis/analyze.ts';
import type { ChildCall } from './ipc.ts';
import type { LiveState } from './live.ts';
import type { ReplayBuffer } from './replay.ts';

export interface DevContext {
  readonly root: string;
  readonly startedAt: string;
  readonly replay: ReplayBuffer;
  readonly live: LiveState;
  analysis(): Promise<Analysis>;
  cachedAnalysis(): Analysis | null;
  snapshot(): Promise<Snapshot>;
  call(call: ChildCall): Promise<unknown>;
  restart(reason: string[]): void;
  paused(paused: boolean): void;
}
