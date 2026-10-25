import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { defineApp, type AppDefinition } from '@murmur/node';
import { createMemoryTransport, type MemoryTransport } from '@murmur/transport-memory';
import type { Envelope } from 'murmur';

export const fixture = (name: string): string => join(import.meta.dirname, 'fixtures', name);

export async function until(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  if (check()) {
    return;
  }

  if (timeoutMs <= 0) {
    throw new Error('condition not met in time');
  }

  await delay(5);
  await until(check, timeoutMs - 5);
}

export async function eventually(probe: () => Promise<boolean>, tries = 200): Promise<void> {
  if (await probe()) {
    return;
  }

  if (tries <= 0) {
    throw new Error('condition not met in time');
  }

  await delay(5);
  await eventually(probe, tries - 1);
}

export function memoryApp(
  name: string,
  extra: Partial<AppDefinition> = {},
): { app: AppDefinition; memory: MemoryTransport } {
  const memory = createMemoryTransport();

  return { app: defineApp({ name, transport: memory, ...extra }), memory };
}

export function named(envelopes: readonly Envelope[], name: string): Envelope[] {
  return envelopes.filter((e) => e.name === name);
}

export function payloadOf(envelope: Envelope | undefined): Record<string, unknown> {
  return (envelope?.payload ?? {}) as Record<string, unknown>;
}
