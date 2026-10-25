import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { BootReport, Frame, Snapshot } from '@murmur/dev-protocol';
import type { Envelope } from 'murmur';

import { analyze, type Analysis } from '../analysis/analyze.ts';
import { writeLaneSnapshot } from '../analysis/lane-snapshot.ts';
import type { Catalog } from '../analysis/types.ts';
import { createAnalysisCache, type AnalysisCache } from './analysis-cache.ts';
import { CallError, spawnChild, type ChildExit, type ChildHandle } from './child-process.ts';
import type { DevContext } from './context.ts';
import { withEnvFiles } from './env-files.ts';
import { createFrames, type FrameSequence } from './frames.ts';
import type { BootInfo, ChildMessage } from './ipc.ts';
import { createLive, type LiveState } from './live.ts';
import { baseUrl, removeLock, writeLock } from './lock.ts';
import { metaOf } from './meta.ts';
import { applyPayloadPolicy, type PayloadPolicy } from './payload.ts';
import { createReplay, type ReplayBuffer } from './replay.ts';
import { createDevServer } from './server.ts';
import { EMPTY_CATALOG, toSnapshot } from './snapshot.ts';
import { createHub, type SseHub } from './sse.ts';
import { createTraceWriter, type TraceWriter } from './trace-store.ts';
import { resolveUiDist } from './ui.ts';
import { startWatcher } from './watcher.ts';

export interface DevOptions {
  readonly root: string;
  readonly host: string;
  readonly port: number;
  readonly ui: boolean;
  readonly watch: boolean;
  readonly watchTests: boolean;
  readonly process: string | undefined;
  readonly replay: number;
  readonly payload: PayloadPolicy;
  readonly traceDir: string;
  readonly inspect: boolean;
  readonly envFiles: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly onFrame: (frame: Frame) => void;
  readonly onLine: (line: string) => void;
}

export type Ready = Snapshot | BootReport | null;

export interface Supervisor {
  readonly url: string;
  readonly ready: Promise<Ready>;
  stop(): Promise<void>;
}

interface State {
  readonly options: DevOptions;
  readonly startedAt: string;
  readonly replay: ReplayBuffer;
  readonly live: LiveState;
  readonly hub: SseHub;
  readonly frames: FrameSequence;
  readonly traces: TraceWriter;
  readonly ready: PromiseWithResolvers<Ready>;
  readonly analysis: AnalysisCache;
  readonly aborted: AbortController;
  child: ChildHandle | null;
  restarting: Promise<void> | null;
  queued: string[];
  paused: boolean;
  stopped: boolean;
}

const DESCRIBE_TIMEOUT_MS = 10_000;

function snapshotFrom(state: State, catalog: Catalog): Snapshot {
  return toSnapshot({ root: state.options.root, catalog, live: state.live, lastSeq: state.frames.last() });
}

function cachedSnapshot(state: State): Snapshot {
  return snapshotFrom(state, state.analysis.cached()?.catalog ?? EMPTY_CATALOG);
}

async function freshSnapshot(state: State): Promise<Snapshot> {
  const analysis = await state.analysis.latest().catch(() => state.analysis.cached());

  return snapshotFrom(state, analysis?.catalog ?? EMPTY_CATALOG);
}

function onEnvelope(state: State, raw: Envelope): void {
  const envelope = applyPayloadPolicy(raw, state.options.payload);
  state.live.apply(envelope);
  const meta = metaOf(raw);
  const { seq } = state.frames.publish({ frame: 'env', envelope, meta });
  state.replay.push({ seq, envelope, meta });
  state.traces.track({ seq, envelope, meta });
}

async function onBoot(state: State, handle: ChildHandle, info: BootInfo): Promise<void> {
  if (state.child !== handle) {
    return;
  }

  state.live.booted(info);
  const snapshot = await freshSnapshot(state);

  if (state.child !== handle) {
    return;
  }

  state.frames.publish({ frame: 'dev.boot', snapshot, durationMs: info.bootDurationMs });
  state.ready.resolve(snapshot);
}

function onBootFailed(state: State, report: BootReport): void {
  state.live.bootFailed(report);
  state.frames.publish({ frame: 'dev.boot_failed', report });
  state.ready.resolve(report);
}

function onMessage(state: State, handle: ChildHandle, message: ChildMessage): void {
  if (message.t === 'env') {
    onEnvelope(state, message.envelope);
  } else if (message.t === 'boot') {
    onBoot(state, handle, message.info).catch((error: unknown) => state.options.onLine(String(error)));
  } else if (message.t === 'boot_failed') {
    onBootFailed(state, message.report);
  }
}

function onExit(state: State, handle: ChildHandle, exit: ChildExit): void {
  if (state.child === handle) {
    state.child = null;
  }

  state.live.childExited();
  state.frames.publish({
    frame: 'dev.child_exit',
    code: exit.code,
    signal: exit.signal,
    drained: state.live.drained(),
  });
  state.ready.resolve(null);
}

function spawn(state: State): void {
  const { options } = state;
  const handle = spawnChild({
    root: options.root,
    process: options.process,
    envFiles: options.envFiles,
    inspect: options.inspect,
    onMessage: (message) => onMessage(state, handle, message),
    onLine: options.onLine,
  });
  void handle.exited.then((exit) => onExit(state, handle, exit));
  state.child = handle;
  state.live.spawned();
  setPaused(state, false);
}

function setPaused(state: State, paused: boolean): void {
  if (state.paused === paused) {
    return;
  }

  state.paused = paused;
  state.frames.publish({ frame: paused ? 'dev.paused' : 'dev.resumed' });
}

async function cycle(state: State, reason: string[]): Promise<void> {
  state.frames.publish({ frame: 'dev.restart', reason });
  state.analysis.refresh();
  await state.child?.stop();

  if (!state.stopped) {
    spawn(state);
  }
}

function restart(state: State, reason: string[]): void {
  if (state.stopped) {
    return;
  }

  if (state.restarting !== null) {
    state.queued.push(...reason);

    return;
  }

  state.restarting = cycle(state, reason).finally(() => {
    state.restarting = null;
    const next = state.queued;
    state.queued = [];

    if (next.length > 0) {
      restart(state, next);
    }
  });
}

function callChild(state: State): DevContext['call'] {
  return (call) =>
    state.child === null
      ? Promise.reject(
          new CallError({ status: 503, error: { name: 'AppDownError', message: 'the app is not running' } }),
        )
      : state.child.call(call);
}

function contextOf(state: State): DevContext {
  return {
    root: state.options.root,
    startedAt: state.startedAt,
    replay: state.replay,
    live: state.live,
    analysis: () => state.analysis.latest(),
    cachedAnalysis: () => state.analysis.cached(),
    snapshot: () => freshSnapshot(state),
    call: callChild(state),
    restart: (reason) => restart(state, reason),
    paused: (paused) => setPaused(state, paused),
  };
}

async function listen(state: State): Promise<{ server: Server; url: string }> {
  const { options } = state;
  const server = createDevServer({
    ctx: contextOf(state),
    events: {
      hub: state.hub,
      replay: state.replay,
      snapshot: () => cachedSnapshot(state),
      lastSeq: state.frames.last,
    },
    ui: { enabled: options.ui, dist: options.ui ? resolveUiDist() : null },
    host: options.host,
  });
  server.listen(options.port, options.host);
  await once(server, 'listening');

  return { server, url: baseUrl({ host: options.host, port: (server.address() as AddressInfo).port }) };
}

function snapshotted(analysis: Analysis): Analysis {
  writeLaneSnapshot(analysis, 'dev');

  return analysis;
}

function createState(options: DevOptions): State {
  const aborted = new AbortController();
  const replay = createReplay(options.replay);
  const hub = createHub(() => frames.last());
  const frames = createFrames((frame) => {
    hub.broadcast(frame);
    options.onFrame(frame);
  });

  return {
    options,
    startedAt: new Date().toISOString(),
    replay,
    live: createLive(),
    hub,
    frames,
    traces: createTraceWriter(options.traceDir, (traceId) => replay.byTrace(traceId)),
    ready: Promise.withResolvers<Ready>(),
    analysis: createAnalysisCache(() =>
      analyze(options.root, withEnvFiles(options.root, options.envFiles, options.env), {
        timeoutMs: DESCRIBE_TIMEOUT_MS,
        signal: aborted.signal,
      }).then(snapshotted),
    ),
    aborted,
    child: null,
    restarting: null,
    queued: [],
    paused: false,
    stopped: false,
  };
}

async function shutdown(state: State, server: Server, watcher: { close(): void } | null): Promise<void> {
  state.stopped = true;
  state.aborted.abort();
  watcher?.close();
  await state.restarting;
  await state.child?.stop();
  state.traces.close();
  state.hub.close();
  server.closeAllConnections();
  server.close();
  removeLock(state.options.root, process.pid);
}

export async function startSupervisor(options: DevOptions): Promise<Supervisor> {
  const state = createState(options);
  const { server, url } = await listen(state);
  const port = (server.address() as AddressInfo).port;
  writeLock({
    pid: process.pid,
    port,
    host: options.host,
    root: options.root,
    startedAt: state.startedAt,
    protocol: 1,
  });
  spawn(state);
  const watcher = options.watch
    ? startWatcher({
        root: options.root,
        watchTests: options.watchTests,
        onChange: (paths) => restart(state, paths),
      })
    : null;

  return { url, ready: state.ready.promise, stop: () => shutdown(state, server, watcher) };
}
