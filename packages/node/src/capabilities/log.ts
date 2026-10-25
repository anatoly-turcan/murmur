import { serializeError, type Log, type LogLine, type LogRecord, type RunContext } from 'murmur';

import type { SysPublisher } from '../sys.ts';

export type LogLevel = LogRecord['level'];
type Fields = Record<string, unknown>;

const RANK: Readonly<Record<LogLevel, number>> = { debug: 10, info: 20, warn: 30, error: 40 };
const BURST_LIMIT = 1_000;
const BURST_WINDOW_MS = 1_000;
const MUTE_MS = 10_000;

export interface LogDeps {
  readonly sink: (line: LogLine) => void;
  readonly publish: SysPublisher | undefined;
  readonly level: LogLevel;
  readonly mode: 'dev' | 'prod';
  readonly now: () => string;
}

export interface LogScope {
  readonly piece: string;
  readonly run: () => RunContext | undefined;
  readonly fields: Fields;
}

interface Burst {
  windowStart: number;
  count: number;
  mutedUntil: number;
}

export interface LogFactory {
  forCurrent(piece: string, current: () => RunContext | undefined): Log;
}

export function levelOf(env: Readonly<Record<string, string | undefined>>, mode: 'dev' | 'prod'): LogLevel {
  const wanted = env['MURMUR_LOG_LEVEL'];
  if (wanted !== undefined && wanted in RANK) {
    return wanted as LogLevel;
  }

  return mode === 'dev' ? 'debug' : 'info';
}

function prettyLine(line: LogLine): string {
  const fields = line.fields === undefined ? '' : ` ${JSON.stringify(line.fields)}`;
  const error = line.error === undefined ? '' : ` ${line.error.name}: ${line.error.message}`;

  return `${line.ts} ${line.level.toUpperCase().padEnd(5)} ${line.piece} ${line.msg}${fields}${error}`;
}

export function sinkFor(mode: 'dev' | 'prod'): (line: LogLine) => void {
  return (line) => {
    process.stderr.write(`${mode === 'dev' ? prettyLine(line) : JSON.stringify(line)}\n`);
  };
}

function createBursts(deps: LogDeps): (piece: string) => boolean {
  const bursts = new Map<string, Burst>();

  return (piece) => {
    const now = performance.now();
    const burst = bursts.get(piece) ?? { windowStart: now, count: 0, mutedUntil: 0 };
    bursts.set(piece, burst);

    if (now < burst.mutedUntil) {
      return false;
    }

    if (now - burst.windowStart >= BURST_WINDOW_MS) {
      Object.assign(burst, { windowStart: now, count: 0 });
    }

    burst.count += 1;

    if (burst.count <= BURST_LIMIT) {
      return true;
    }

    burst.mutedUntil = now + MUTE_MS;
    deps.sink({
      ts: deps.now(),
      level: 'warn',
      piece,
      msg: `more than ${BURST_LIMIT} log lines per second: $sys.log muted for ${MUTE_MS / 1000} s`,
    });

    return false;
  };
}

function lineOf(
  deps: LogDeps,
  level: LogLevel,
  piece: string,
  msg: string,
  run: RunContext | undefined,
  data: Fields,
): LogLine {
  const { error, ...fields } = data;

  return {
    ts: deps.now(),
    level,
    piece,
    msg,
    ...(run === undefined ? {} : { traceId: run.traceId }),
    ...(run?.eventId === undefined ? {} : { eventId: run.eventId }),
    ...(Object.keys(fields).length === 0 ? {} : { fields }),
    ...(error === undefined ? {} : { error: serializeError(error, deps.mode === 'dev') }),
  };
}

function publishLine(deps: LogDeps, line: LogLine, run: RunContext | undefined): void {
  deps.publish?.(
    'log',
    {
      level: line.level,
      msg: line.msg,
      piece: line.piece,
      traceId: line.traceId,
      eventId: line.eventId,
      deliveryId: run?.deliveryId,
      attempt: run?.attempt,
      fields: line.fields,
      error: line.error,
    },
    { traceId: run?.traceId, hop: run?.hop, source: line.piece },
  );
}

function createLog(deps: LogDeps, allow: (piece: string) => boolean, scope: LogScope): Log {
  const write = (level: LogLevel) => (msg: string, data?: Fields) => {
    if (RANK[level] < RANK[deps.level]) {
      return;
    }

    const run = scope.run();
    const line = lineOf(deps, level, scope.piece, msg, run, { ...scope.fields, ...data });
    deps.sink(line);

    if (run?.internal !== true && allow(scope.piece)) {
      publishLine(deps, line, run);
    }
  };

  return {
    debug: write('debug'),
    info: write('info'),
    warn: write('warn'),
    error: write('error'),
    child: (fields) => createLog(deps, allow, { ...scope, fields: { ...scope.fields, ...fields } }),
  };
}

export function createLogFactory(deps: LogDeps): LogFactory {
  const allow = createBursts(deps);

  return {
    forCurrent: (piece, current) => createLog(deps, allow, { piece, run: current, fields: {} }),
  };
}
