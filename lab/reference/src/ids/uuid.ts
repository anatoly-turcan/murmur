import { randomBytes } from 'node:crypto';

export type Id = string;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LEGACY_RE = /^[1-9][0-9]*$/;
const COUNTER_BITS = 74n;
const RAND_B_BITS = 62n;
const RAND_B_MASK = (1n << RAND_B_BITS) - 1n;
const MAX_STEP = 1n << 24n;

export interface IdGenerator {
  next(ms: number): Id;
}

const POOL_BYTES = 4096;
let pool = randomBytes(POOL_BYTES);
let poolAt = 0;

function randomBig(bytes: number): bigint {
  if (poolAt + bytes > POOL_BYTES) {
    pool = randomBytes(POOL_BYTES);
    poolAt = 0;
  }
  const hex = pool.toString('hex', poolAt, poolAt + bytes);
  poolAt += bytes;

  return BigInt(`0x${hex}`);
}

function freshCounter(): bigint {
  return randomBig(10) & ((1n << (COUNTER_BITS - 1n)) - 1n);
}

function step(): bigint {
  return (randomBig(4) % MAX_STEP) + 1n;
}

export function formatUuidV7(ms: number, counter: bigint): Id {
  const ts = ms.toString(16).padStart(12, '0');
  const randA = ((counter >> RAND_B_BITS) & 0xfffn) | 0x7000n;
  const randB = (counter & RAND_B_MASK) | (2n << RAND_B_BITS);
  const tail = randB.toString(16).padStart(16, '0');

  return `${ts.slice(0, 8)}-${ts.slice(8)}-${randA.toString(16)}-${tail.slice(0, 4)}-${tail.slice(4)}`;
}

// Within one millisecond a generator counts upwards from a random start, so ids it mints sort in creation order.
export function createIdGenerator(): IdGenerator {
  let lastMs = -1;
  let counter = 0n;

  return {
    next(ms) {
      counter = ms === lastMs ? counter + step() : freshCounter();
      lastMs = ms;

      return formatUuidV7(ms, counter);
    },
  };
}

const shared = createIdGenerator();

export function newId(ms: number): Id {
  return shared.next(ms);
}

export function normalizeUuid(raw: string): Id | null {
  return UUID_RE.test(raw) ? raw.toLowerCase() : null;
}

export function legacyInteger(raw: string): number | null {
  if (!LEGACY_RE.test(raw)) return null;
  const n = Number(raw);

  return Number.isSafeInteger(n) ? n : null;
}

export function uuidMillis(id: Id): number {
  return parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
}
