import type { Clock, Ids } from '../model/capabilities.ts';
import type { RunContext } from '../model/context.ts';
import type { Envelope } from '../model/envelope.ts';
import { EnvelopeShapeError } from './errors.ts';

export interface EnvelopeInit<P> {
  name: string;
  payload: P;
  parent?: RunContext;
  correlationId?: string;
  replyTo?: string;
  source?: string;
  ids: Ids;
  clock: Clock;
}

type Field = keyof Envelope;
type FieldType = 'string' | 'hop' | 'json';

const FIELDS: readonly { key: Field; type: FieldType; required: boolean }[] = [
  { key: 'id', type: 'string', required: true },
  { key: 'name', type: 'string', required: true },
  { key: 'traceId', type: 'string', required: true },
  { key: 'causationId', type: 'string', required: false },
  { key: 'correlationId', type: 'string', required: false },
  { key: 'replyTo', type: 'string', required: false },
  { key: 'deadline', type: 'string', required: false },
  { key: 'ts', type: 'string', required: true },
  { key: 'hop', type: 'hop', required: true },
  { key: 'source', type: 'string', required: false },
  { key: 'payload', type: 'json', required: true },
];
const KEYS = new Set<string>(FIELDS.map((f) => f.key));
const TRACE_ID = /^[0-9a-f-]{8,64}$/;

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function ordered(fields: Record<string, unknown>): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const { key } of FIELDS) {
    if (fields[key] !== undefined) {
      record[key] = fields[key];
    }
  }

  return record;
}

export function createEnvelope<P>(init: EnvelopeInit<P>): Envelope<P> {
  const { parent } = init;
  const id = init.ids.uuid();

  return ordered({
    id,
    name: init.name,
    traceId: parent?.traceId ?? id,
    causationId: parent?.eventId,
    correlationId: init.correlationId,
    replyTo: init.replyTo,
    ts: init.clock.now().toString(),
    hop: parent ? parent.hop + 1 : 0,
    source: init.source,
    payload: init.payload,
  }) as unknown as Envelope<P>;
}

function stringify(record: Record<string, unknown>): string {
  try {
    return JSON.stringify(record);
  } catch (error) {
    throw new EnvelopeShapeError(
      `envelope ${String(record['name'])} is not JSON-serializable: ${String(error)}`,
    );
  }
}

const NOT_JSON = new Set(['undefined', 'function', 'symbol']);

export function serializeEnvelope(e: Envelope): string {
  if (NOT_JSON.has(typeof e.payload)) {
    throw new EnvelopeShapeError(
      `envelope ${e.name} has no JSON payload: use null or {} instead of undefined`,
    );
  }

  return stringify(ordered(e as unknown as Record<string, unknown>));
}

function decode(json: string | Uint8Array): unknown {
  try {
    return JSON.parse(typeof json === 'string' ? json : decoder.decode(json));
  } catch {
    throw new EnvelopeShapeError('envelope is not valid JSON');
  }
}

function hasType(value: unknown, type: FieldType): boolean {
  if (type === 'string') {
    return typeof value === 'string';
  }

  if (type === 'hop') {
    return Number.isInteger(value) && (value as number) >= 0;
  }

  return value !== undefined;
}

function checkFields(record: Record<string, unknown>): void {
  for (const key of Object.keys(record)) {
    if (!KEYS.has(key)) {
      throw new EnvelopeShapeError(`envelope has unknown key "${key}"`);
    }
  }

  for (const { key, type, required } of FIELDS) {
    if (!(key in record)) {
      if (required) {
        throw new EnvelopeShapeError(`envelope is missing "${key}"`);
      }

      continue;
    }

    if (!hasType(record[key], type)) {
      throw new EnvelopeShapeError(`envelope field "${key}" has the wrong type`);
    }
  }

  if (!TRACE_ID.test(record['traceId'] as string)) {
    throw new EnvelopeShapeError(`envelope traceId must match ${TRACE_ID.source}`);
  }
}

export function parseEnvelope(json: string | Uint8Array): Envelope {
  const value = decode(json);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new EnvelopeShapeError('envelope must be a JSON object');
  }

  checkFields(value as Record<string, unknown>);

  return value as Envelope;
}

export function envelopeBytes(json: string): number {
  return encoder.encode(json).byteLength;
}
