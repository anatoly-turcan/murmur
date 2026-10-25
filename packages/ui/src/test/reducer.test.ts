import type { Frame, FrameName } from '@murmur/dev-protocol';
import { describe, expect, test } from 'vitest';

import { ringByPiece, ringByTrace, ringItems } from '../store/ring.ts';
import { eventRow } from '../store/rows.ts';
import { connectionChanged, initialState, reduce, type UiState } from '../store/state.ts';
import { envelope, everyFrame, sysEnvelope, todoSnapshot, present } from './fixtures.ts';

const ts = '2026-10-24T10:00:00.000Z';

function run(frames: Frame[], state: UiState = initialState()): UiState {
  return frames.reduce(reduce, state);
}

function hello(seq = 0, replayFrom: number | null = null): Frame {
  return { frame: 'hello', seq, ts, protocol: 1, snapshot: todoSnapshot(), replayFrom };
}

function env(seq: number, e = envelope({ id: `e${seq}` }), internal = false): Frame {
  return { frame: 'env', seq, ts, envelope: e, meta: { internal, piece: e.source ?? 'x' } };
}

function sys(seq: number, name: string, payload: Record<string, unknown>): Frame {
  return {
    frame: 'env',
    seq,
    ts,
    envelope: sysEnvelope(name, payload, { id: `s${seq}` }),
    meta: { internal: true, piece: String(payload['piece']) },
  };
}

describe('reducer', () => {
  test('handles every Frame variant and bumps the version each time', () => {
    const frames = everyFrame(todoSnapshot());
    const names = new Set<FrameName>(frames.map((f) => f.frame));
    const all: Record<FrameName, true> = {
      hello: true,
      env: true,
      'dev.restart': true,
      'dev.boot': true,
      'dev.boot_failed': true,
      'dev.child_exit': true,
      'dev.paused': true,
      'dev.resumed': true,
      ping: true,
    };
    expect([...names].toSorted()).toEqual(Object.keys(all).toSorted());

    let state = initialState();
    for (const frame of frames) {
      const next = reduce(state, frame);
      expect(next).not.toBe(state);
      expect(next.version).toBe(state.version + 1);
      state = next;
    }

    expect(state.lastSeq).toBe(8);
  });

  test('hello installs the snapshot, goes live and seeds counters', () => {
    const snapshot = todoSnapshot();
    present(snapshot.pieces[0]).counters.acked = 7;
    const state = run([{ frame: 'hello', seq: 0, ts, protocol: 1, snapshot, replayFrom: null }]);
    expect(state.connection).toBe('live');
    expect(state.snapshot?.app.name).toBe('todo-api');
    expect(state.live.get('todos/create')?.counters.acked).toBe(7);
  });

  test('env appends to the ring and indexes by trace and piece; duplicates are ignored', () => {
    const state = run([hello(), env(1), env(2, envelope({ id: 'e2', traceId: 'trace-2' })), env(2)]);
    expect(ringItems(state.ring).map((s) => s.seq)).toEqual([1, 2]);
    expect(ringByTrace(state.ring, 'trace-1').map((s) => s.seq)).toEqual([1]);
    expect(ringByPiece(state.ring, 'todos/create').map((s) => s.seq)).toEqual([1, 2]);
    expect(state.lastSeq).toBe(2);
  });

  test('$sys.delivery.* frames drive per-piece counters, failure marks and sparklines', () => {
    const ref = { deliveryId: 'd1', envelopeId: 'e1', name: 'todo.created', piece: 'stats/count' };
    const state = run([
      hello(),
      env(1),
      sys(2, 'delivery.received', { ...ref, attempt: 1, redelivered: false, traceId: 'trace-1' }),
      sys(3, 'delivery.failed', {
        ...ref,
        attempt: 1,
        durationMs: 4,
        willRetry: true,
        phase: 'handler',
        error: { name: 'Error', message: 'boom' },
      }),
      sys(4, 'delivery.retried', { ...ref, nextAttempt: 2, delayMs: 200 }),
      sys(5, 'delivery.received', { ...ref, attempt: 2, redelivered: false, traceId: 'trace-1' }),
      sys(6, 'delivery.acked', { ...ref, attempt: 2, durationMs: 3, replied: false }),
    ]);
    const live = state.live.get('stats/count');
    expect(live?.counters).toEqual({
      received: 2,
      acked: 1,
      failed: 1,
      retried: 1,
      deadLettered: 0,
      inflight: 0,
    });
    expect(live?.failedAt).toBe(Date.parse('2026-10-24T10:00:01.000Z'));
    expect(live?.durations).toEqual([4, 3]);
    expect(live?.spark.reduce((a, b) => a + b, 0)).toBe(2);
  });

  test('deadlettered increments and the event row reflects the terminal outcome', () => {
    const e = envelope({ id: 'e1' });
    const state = run([
      hello(),
      env(1, e),
      sys(2, 'delivery.received', {
        deliveryId: 'd',
        envelopeId: 'e1',
        name: e.name,
        piece: 'audit/record',
        attempt: 1,
        redelivered: false,
        traceId: 'trace-1',
      }),
      sys(3, 'delivery.deadlettered', {
        deliveryId: 'd',
        envelope: e,
        piece: 'audit/record',
        attempts: 1,
        phase: 'handler',
        error: { name: 'Error', message: 'x' },
      }),
    ]);
    expect(state.live.get('audit/record')?.counters.deadLettered).toBe(1);
    const row = eventRow(state.ring, present(ringItems(state.ring)[0]));
    expect(row.to).toEqual(['audit/record']);
    expect(row.outcome).toBe('deadLettered');
  });

  test('ring evicts the oldest entries at capacity and prunes the indexes', () => {
    const frames = [
      hello(),
      ...Array.from({ length: 5 }, (_, i) => env(i + 1, envelope({ id: `e${i + 1}`, traceId: `t${i % 2}` }))),
    ];
    const state = run(frames, initialState(3));
    expect(ringItems(state.ring).map((s) => s.seq)).toEqual([3, 4, 5]);
    expect(ringByTrace(state.ring, 't0').map((s) => s.seq)).toEqual([3, 5]);
    expect(ringByTrace(state.ring, 't1').map((s) => s.seq)).toEqual([4]);
    expect(state.ring.evicted).toBe(2);
  });

  test('hello after a reconnect reports events lost to buffer eviction', () => {
    const state = run([hello(), env(1), env(2), hello(10, 50)]);
    expect(state.missed).toBe(47);
    expect(run([hello(), env(1), hello(10, 2)]).missed).toBe(0);
  });

  test('restart dims, boot restores, boot_failed keeps the last good snapshot', () => {
    const snapshot = todoSnapshot();
    const restarting = run([hello(), { frame: 'dev.restart', seq: 1, ts, reason: ['a.ts'] }]);
    expect(restarting.phase).toBe('restarting');
    expect(restarting.restartReason).toEqual(['a.ts']);

    const failed = reduce(restarting, present(everyFrame(snapshot)[6]));
    expect(failed.phase).toBe('boot-failed');
    expect(failed.bootReport?.errors).toHaveLength(1);
    expect(failed.snapshot?.app.name).toBe('todo-api');

    const booted = reduce(failed, {
      frame: 'dev.boot',
      seq: 9,
      ts,
      snapshot: { ...snapshot, lastSeq: 9 },
      durationMs: 33,
    });
    expect(booted.phase).toBe('running');
    expect(booted.bootReport).toBeNull();
    expect(booted.snapshot?.lastSeq).toBe(9);
    expect(booted.bootDurationMs).toBe(33);
  });

  test('child exit, pause/resume and ping', () => {
    const state = run([
      hello(),
      { frame: 'dev.child_exit', seq: 1, ts, code: 1, signal: null, drained: false },
      { frame: 'dev.paused', seq: 2, ts },
    ]);
    expect(state.lastExit).toEqual({ code: 1, signal: null, drained: false });
    expect(state.paused).toBe(true);
    const resumed = run(
      [
        { frame: 'dev.resumed', seq: 3, ts },
        { frame: 'ping', seq: 4, ts },
      ],
      state,
    );
    expect(resumed.paused).toBe(false);
    expect(resumed.lastSeq).toBe(4);
  });

  test('connection status changes are separate from frames', () => {
    const state = connectionChanged(run([hello()]), 'reconnecting');
    expect(state.connection).toBe('reconnecting');
  });
});
