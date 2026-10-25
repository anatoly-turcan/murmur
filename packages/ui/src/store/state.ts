import type { BootReport, Frame, Snapshot, StoredEnvelope } from '@murmur/dev-protocol';

import { applyFact, emptyLive, seedLive, type PieceLive } from './live.ts';
import { createRing, pushRing, type Ring } from './ring.ts';
import { deliveryFact } from './sys.ts';

export const RING_CAPACITY = 20_000;

export type ConnectionStatus = 'connecting' | 'live' | 'reconnecting';
export type AppPhase = 'running' | 'restarting' | 'boot-failed';

export interface ChildExit {
  code: number | null;
  signal: string | null;
  drained: boolean | null;
}

export interface UiState {
  version: number;
  connection: ConnectionStatus;
  phase: AppPhase;
  snapshot: Snapshot | null;
  bootReport: BootReport | null;
  bootDurationMs: number | null;
  restartReason: string[];
  lastExit: ChildExit | null;
  paused: boolean;
  lastSeq: number;
  missed: number;
  ring: Ring;
  live: Map<string, PieceLive>;
  lastEnv: StoredEnvelope | null;
}

export function initialState(capacity = RING_CAPACITY): UiState {
  return {
    version: 0,
    connection: 'connecting',
    phase: 'running',
    snapshot: null,
    bootReport: null,
    bootDurationMs: null,
    restartReason: [],
    lastExit: null,
    paused: false,
    lastSeq: 0,
    missed: 0,
    ring: createRing(capacity),
    live: new Map(),
    lastEnv: null,
  };
}

type FrameOf<N extends Frame['frame']> = Extract<Frame, { frame: N }>;

function onHello(state: UiState, frame: FrameOf<'hello'>): Partial<UiState> {
  const gap = state.lastSeq > 0 && frame.replayFrom !== null ? frame.replayFrom - state.lastSeq - 1 : 0;

  return {
    connection: 'live',
    snapshot: frame.snapshot,
    live: seedLive(frame.snapshot, state.live),
    missed: state.missed + Math.max(0, gap),
    phase: state.phase === 'restarting' ? 'running' : state.phase,
  };
}

function applyDelivery(live: Map<string, PieceLive>, stored: StoredEnvelope): void {
  const fact = deliveryFact(stored);
  if (!fact) {
    return;
  }

  let entry = live.get(fact.piece);
  if (!entry) {
    entry = emptyLive();
    live.set(fact.piece, entry);
  }

  applyFact(entry, fact);
}

function onEnv(state: UiState, frame: FrameOf<'env'>): Partial<UiState> {
  const stored: StoredEnvelope = { seq: frame.seq, envelope: frame.envelope, meta: frame.meta };
  if (!pushRing(state.ring, stored)) {
    return {};
  }

  applyDelivery(state.live, stored);

  return { lastEnv: stored };
}

function onFrame(state: UiState, frame: Frame): Partial<UiState> {
  switch (frame.frame) {
    case 'hello':
      return onHello(state, frame);
    case 'env':
      return onEnv(state, frame);
    case 'dev.restart':
      return { phase: 'restarting', restartReason: frame.reason };
    case 'dev.boot':
      return {
        phase: 'running',
        snapshot: frame.snapshot,
        bootReport: null,
        bootDurationMs: frame.durationMs,
        live: seedLive(frame.snapshot, state.live),
      };
    case 'dev.boot_failed':
      return { phase: 'boot-failed', bootReport: frame.report };
    case 'dev.child_exit':
      return { lastExit: { code: frame.code, signal: frame.signal, drained: frame.drained } };
    case 'dev.paused':
      return { paused: true };
    case 'dev.resumed':
      return { paused: false };
    case 'ping':
      return {};
  }
}

export function reduce(state: UiState, frame: Frame): UiState {
  const patch = onFrame(state, frame);
  const lastSeq = frame.frame === 'hello' ? state.lastSeq : Math.max(state.lastSeq, frame.seq);

  return { ...state, ...patch, lastSeq, version: state.version + 1 };
}

export function connectionChanged(state: UiState, connection: ConnectionStatus): UiState {
  if (state.connection === connection) {
    return state;
  }

  return { ...state, connection, version: state.version + 1 };
}

export function missedCleared(state: UiState): UiState {
  return { ...state, missed: 0, version: state.version + 1 };
}
