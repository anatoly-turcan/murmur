import { defineCapability } from 'murmur';

import { Authenticate, RateLimit } from '../fixtures/v2/contracts/auth.ts';
import { http, type RequestOf } from './http.ts';

export interface Db {
  get<Row>(sql: string, ...params: unknown[]): Promise<Row | undefined>;
  run(sql: string, ...params: unknown[]): Promise<{ changes: number }>;
}

export interface Kv {
  get(key: string): Promise<string | undefined>;
}

export const sqlite = defineCapability({
  name: 'sqlite',
  start: (): Db => ({ get: async () => undefined, run: async () => ({ changes: 0 }) }),
});

export const kv = defineCapability({ name: 'kv', start: (): Kv => ({ get: async () => undefined }) });

const web = http({ guards: [Authenticate, RateLimit] });

export default web;

export type WebRequest = RequestOf<typeof web>;

export const open = http();
