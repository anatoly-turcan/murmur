import type { Frame } from '@murmur/dev-protocol';
import type { Envelope, SerializedError } from 'murmur';

import { clockTime } from './time.ts';

type EnvFrame = Extract<Frame, { frame: 'env' }>;

export interface TailOptions {
  readonly internal: boolean;
  readonly failed: boolean;
  readonly payload: boolean;
  readonly handlers: (contract: string) => readonly string[];
}

interface FailurePayload {
  readonly piece: string;
  readonly name?: string;
  readonly envelope?: Envelope;
  readonly attempt?: number;
  readonly attempts?: number;
  readonly durationMs?: number;
  readonly willRetry?: boolean;
  readonly error: SerializedError;
}

const short = (id: string | undefined) => (id === undefined ? '—' : id.slice(0, 4));
const sourceOf = (envelope: Envelope) => (envelope.source ?? '—').replace(/^external:/, '');

function markerOf(reply: boolean, hop: number): string {
  if (reply) {
    return '↩';
  }

  return hop === 0 ? '▸' : ' ';
}

function failureOutcome(name: string, willRetry: boolean): string {
  if (name.endsWith('deadlettered')) {
    return 'dead-lettered';
  }

  return willRetry ? 'retrying' : 'failed';
}

function jobContract(envelope: Envelope): string | null {
  if (envelope.name !== '$ingress.job') {
    return null;
  }

  const binding: unknown = Reflect.get(Object(envelope.payload), 'binding');

  return typeof binding === 'string' ? binding : null;
}

function userLine(frame: EnvFrame, options: TailOptions): string {
  const { envelope } = frame;
  const reply = envelope.name.startsWith('$reply.');
  const marker = markerOf(reply, envelope.hop);
  const job = jobContract(envelope);
  const entry = job === null ? envelope.name : `job ${job}`;
  const name = reply ? 'reply' : entry;
  const targets = reply ? [] : options.handlers(job ?? envelope.name);
  const handlers = targets.length === 0 ? '—' : targets.join(', ');
  const route = reply ? '' : ` → ${handlers}`;
  const payload = options.payload ? `  ${JSON.stringify(envelope.payload)}` : '';

  return `${clockTime(frame.ts)}  ${marker} ${name.padEnd(30)} tr=${short(envelope.traceId)} c=${short(envelope.correlationId).padEnd(5)} from ${sourceOf(envelope).padEnd(16)}${route}${payload}`;
}

function failureLine(frame: EnvFrame): string {
  const payload = frame.envelope.payload as FailurePayload;
  const name = payload.name ?? payload.envelope?.name ?? '?';
  const attempt = payload.attempt ?? payload.attempts ?? 0;
  const outcome = failureOutcome(frame.envelope.name, payload.willRetry === true);
  const duration = payload.durationMs === undefined ? '' : `  ${payload.durationMs}ms`;

  return `${clockTime(frame.ts)}  ✖ ${payload.piece} ← ${name}  attempt ${attempt} ${outcome}${duration}  ${payload.error.name}: ${payload.error.message}`;
}

function envLine(frame: EnvFrame, options: TailOptions): string | null {
  if (frame.meta.failed === true && frame.envelope.name !== '$sys.delivery.timeout') {
    return failureLine(frame);
  }

  if (options.failed) {
    return null;
  }

  if (!frame.meta.internal) {
    return userLine(frame, options);
  }

  return options.internal
    ? `${clockTime(frame.ts)}  · ${frame.envelope.name.padEnd(30)} ${frame.meta.piece ?? ''}`.trimEnd()
    : null;
}

function devLine(frame: Exclude<Frame, EnvFrame>): string | null {
  const at = clockTime(frame.ts);
  switch (frame.frame) {
    case 'dev.restart':
      return `${at}  ↻ restart  ${frame.reason.join(', ')}`;
    case 'dev.boot':
      return `${at}  ✓ boot  pieces=${frame.snapshot.pieces.length}  ${frame.durationMs}ms`;
    case 'dev.boot_failed':
      return [
        `${at}  ✖ boot failed`,
        ...frame.report.errors.map(
          (e) => `    ${e.phase}: ${e.message}${e.file === undefined ? '' : `  (${e.file})`}`,
        ),
      ].join('\n');
    case 'dev.child_exit':
      return `${at}  ■ app exited  code=${frame.code ?? '—'} signal=${frame.signal ?? '—'} drained=${frame.drained ?? '—'}`;
    case 'dev.paused':
      return `${at}  ‖ paused`;
    case 'dev.resumed':
      return `${at}  ▶ resumed`;
    default:
      return null;
  }
}

export function tailLine(frame: Frame, options: TailOptions): string | null {
  if (frame.frame === 'env') {
    return envLine(frame, options);
  }

  return options.failed ? null : devLine(frame);
}
