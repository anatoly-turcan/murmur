import type { Envelope } from 'murmur';

import type { BootReport, Snapshot } from './catalog.ts';
import type { EnvMeta } from './trace.ts';

interface FrameBase {
  seq: number;
  ts: string;
}

export type Frame =
  | (FrameBase & { frame: 'hello'; protocol: 1; snapshot: Snapshot; replayFrom: number | null })
  | (FrameBase & { frame: 'env'; envelope: Envelope; meta: EnvMeta })
  | (FrameBase & { frame: 'dev.restart'; reason: string[] })
  | (FrameBase & { frame: 'dev.boot'; snapshot: Snapshot; durationMs: number })
  | (FrameBase & { frame: 'dev.boot_failed'; report: BootReport })
  | (FrameBase & {
      frame: 'dev.child_exit';
      code: number | null;
      signal: string | null;
      drained: boolean | null;
    })
  | (FrameBase & { frame: 'dev.paused' | 'dev.resumed' })
  | (FrameBase & { frame: 'ping' });

export type FrameName = Frame['frame'];
