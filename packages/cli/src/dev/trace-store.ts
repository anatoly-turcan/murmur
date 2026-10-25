import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { StoredEnvelope } from '@murmur/dev-protocol';
import { isInternal } from 'murmur';

import { isReplyName } from './meta.ts';

const QUIET_MS = 2_000;
const MAX_TRACE_FILES = 500;

export interface TraceWriter {
  track(stored: StoredEnvelope): void;
  close(): void;
}

function isUserEnvelope(stored: StoredEnvelope): boolean {
  return !isInternal(stored.envelope.name) && !isReplyName(stored.envelope.name);
}

function writeTrace(dir: string, traceId: string, items: readonly StoredEnvelope[], maxFiles: number): void {
  if (!items.some(isUserEnvelope)) {
    return;
  }

  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${traceId}.ndjson`), `${items.map((item) => JSON.stringify(item)).join('\n')}\n`);
  prune(dir, maxFiles);
}

function prune(dir: string, keep: number): void {
  const files = traceFiles(dir, '');
  if (files.length <= keep) {
    return;
  }

  const oldestFirst = files
    .map((path) => ({ path, mtimeMs: statSync(path).mtimeMs }))
    .toSorted((a, b) => a.mtimeMs - b.mtimeMs);

  for (const { path } of oldestFirst.slice(0, files.length - keep)) {
    rmSync(path, { force: true });
  }
}

export function createTraceWriter(
  dir: string,
  read: (traceId: string) => StoredEnvelope[],
  maxFiles = MAX_TRACE_FILES,
): TraceWriter {
  const timers = new Map<string, NodeJS.Timeout>();
  const flush = (traceId: string) => {
    timers.delete(traceId);

    try {
      writeTrace(dir, traceId, read(traceId), maxFiles);
    } catch {
      return;
    }
  };

  return {
    track: ({ envelope: { traceId } }) => {
      clearTimeout(timers.get(traceId));
      timers.set(traceId, setTimeout(flush, QUIET_MS, traceId).unref());
    },
    close: () => {
      for (const [traceId, timer] of timers) {
        clearTimeout(timer);
        flush(traceId);
      }
    },
  };
}

function parseLines(text: string): StoredEnvelope[] {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as StoredEnvelope);
}

function traceFiles(dir: string, prefix: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.ndjson') && name.startsWith(prefix))
    .map((name) => join(dir, name));
}

export function findTraceFiles(source: string, prefix: string): string[] {
  if (!existsSync(source)) {
    return [];
  }

  if (!statSync(source).isDirectory()) {
    return [source];
  }

  return traceFiles(source, prefix);
}

export function readTraceItems(file: string, prefix: string): StoredEnvelope[] {
  const items = parseLines(readFileSync(file, 'utf8'));

  return items.filter((item) => item.envelope.traceId.startsWith(prefix));
}
