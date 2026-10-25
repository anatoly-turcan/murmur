import type { BootReport, EmitRequest } from '@murmur/dev-protocol';
import type { Envelope } from 'murmur';

export interface ChildInit {
  readonly root: string;
  readonly process: string | undefined;
}

export interface BootInfo {
  readonly app: string;
  readonly transport: string;
  readonly startedAt: string;
  readonly bootDurationMs: number;
  readonly pieces: readonly string[];
}

export type ChildCall = { op: 'emit'; request: EmitRequest } | { op: 'pause' } | { op: 'resume' };

export interface CallFailure {
  readonly status: number;
  readonly error: { name: string; message: string; code?: string; issues?: unknown };
}

export type ChildMessage =
  | { t: 'env'; envelope: Envelope }
  | { t: 'boot'; info: BootInfo }
  | { t: 'boot_failed'; report: BootReport }
  | { t: 'stopped' }
  | { t: 'reply'; id: number; ok: true; value: unknown }
  | ({ t: 'reply'; id: number; ok: false } & CallFailure);

export interface ParentMessage {
  readonly t: 'call';
  readonly id: number;
  readonly call: ChildCall;
}
