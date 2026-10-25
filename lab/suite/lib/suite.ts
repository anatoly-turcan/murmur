import { before, beforeEach } from 'node:test';
import { reset } from './testmode.ts';

// Each test starts from POST /__test/reset (SPEC 13.4), so tests and files are order-independent.
export function freshDatabaseEachTest(): void {
  beforeEach(reset);
}

// For files whose tests only read a shared world and never mutate it.
export function freshDatabaseOnce(): void {
  before(reset);
}

export function lazy<T>(build: () => Promise<T>): () => Promise<T> {
  let value: Promise<T> | undefined;

  return () => {
    value ??= build();

    return value;
  };
}
