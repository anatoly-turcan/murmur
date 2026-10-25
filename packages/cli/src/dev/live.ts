import type { BootReport, LogLine, PieceCounters, PieceView } from '@murmur/dev-protocol';
import type { DeliveryPolicy, Envelope, SysEvent } from 'murmur';

import type { BootInfo } from './ipc.ts';

export interface PieceLive {
  status: PieceView['status'];
  policy: DeliveryPolicy | null;
  counters: PieceCounters;
  lastDeliveryAt: string | null;
  samples: number[];
}

export interface LiveState {
  apply(envelope: Envelope): void;
  booted(info: BootInfo): void;
  bootFailed(report: BootReport): void;
  spawned(): void;
  childExited(): void;
  piece(name: string): PieceLive | undefined;
  logs(): readonly LogLine[];
  info(): BootInfo | null;
  drained(): boolean | null;
}

const SAMPLE_LIMIT = 200;
const LOG_LIMIT = 2_000;

function emptyPiece(): PieceLive {
  return {
    status: 'starting',
    policy: null,
    counters: { received: 0, acked: 0, failed: 0, retried: 0, deadLettered: 0, inflight: 0 },
    lastDeliveryAt: null,
    samples: [],
  };
}

function settle(live: PieceLive, at: string): void {
  live.counters.inflight = Math.max(0, live.counters.inflight - 1);
  live.lastDeliveryAt = at;
}

function onAcked(live: PieceLive, payload: SysEvent<'delivery.acked'>): void {
  live.counters.acked += 1;
  settle(live, payload.at);
  live.samples.push(payload.durationMs);

  if (live.samples.length > SAMPLE_LIMIT) {
    live.samples.shift();
  }
}

function onFailed(live: PieceLive, payload: SysEvent<'delivery.failed'>): void {
  live.counters.failed += 1;
  settle(live, payload.at);
}

type Updater = (live: PieceLive, payload: never) => void;

const UPDATERS: Readonly<Record<string, Updater>> = {
  '$sys.piece.started': (live, payload: SysEvent<'piece.started'>) => {
    live.status = 'running';
    live.policy = payload.policy;
  },
  '$sys.piece.stopped': (live) => {
    live.status = 'stopped';
  },
  '$sys.piece.failed': (live) => {
    live.status = 'failed';
  },
  '$sys.delivery.received': (live) => {
    live.counters.received += 1;
    live.counters.inflight += 1;
  },
  '$sys.delivery.acked': onAcked,
  '$sys.delivery.failed': onFailed,
  '$sys.delivery.retried': (live) => {
    live.counters.retried += 1;
  },
  '$sys.delivery.deadlettered': (live) => {
    live.counters.deadLettered += 1;
  },
};

function logLine(payload: SysEvent<'log'>): LogLine {
  const { level, msg, piece, traceId, eventId, fields, error } = payload;

  return {
    ts: payload.at,
    level,
    msg,
    piece,
    ...(traceId === undefined ? {} : { traceId }),
    ...(eventId === undefined ? {} : { eventId }),
    ...(fields === undefined ? {} : { fields }),
    ...(error === undefined ? {} : { error }),
  };
}

export function percentile(samples: readonly number[], p: number): number | null {
  if (samples.length === 0) {
    return null;
  }

  const sorted = samples.toSorted((a, b) => a - b);

  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? null;
}

export function createLive(): LiveState {
  const pieces = new Map<string, PieceLive>();
  const logs: LogLine[] = [];
  let info: BootInfo | null = null;
  let drained: boolean | null = null;
  const pieceOf = (name: string): PieceLive => {
    const existing = pieces.get(name);
    if (existing !== undefined) {
      return existing;
    }

    const created = emptyPiece();
    pieces.set(name, created);

    return created;
  };

  return {
    apply: (envelope) => {
      const payload = envelope.payload as { piece?: unknown };
      if (envelope.name === '$sys.runtime.stopped') {
        drained = (payload as SysEvent<'runtime.stopped'>).drained;
      }

      if (envelope.name === '$sys.log') {
        logs.push(logLine(payload as SysEvent<'log'>));

        if (logs.length > LOG_LIMIT) {
          logs.shift();
        }
      }

      const update = UPDATERS[envelope.name];
      if (update !== undefined && typeof payload.piece === 'string') {
        update(pieceOf(payload.piece), payload as never);
      }
    },
    booted: (next) => {
      info = next;

      for (const name of next.pieces) {
        pieceOf(name);
      }
    },
    bootFailed: (report) => {
      for (const { name, errors } of report.pieces) {
        pieceOf(name).status = errors.length > 0 ? 'failed' : 'stopped';
      }
    },
    spawned: () => {
      drained = null;
    },
    childExited: () => {
      for (const live of pieces.values()) {
        if (live.status === 'running') {
          live.status = 'stopped';
        }

        live.counters.inflight = 0;
      }
    },
    piece: (name) => pieces.get(name),
    logs: () => logs,
    info: () => info,
    drained: () => drained,
  };
}
