import { fold } from '../../text/normalize.ts';

export type Rng = () => number;

export const TIMEZONES = (
  'UTC Europe/London Europe/Dublin Europe/Lisbon Europe/Paris Europe/Berlin Europe/Madrid Europe/Rome Europe/Amsterdam ' +
  'Europe/Vienna Europe/Zurich Europe/Stockholm Europe/Helsinki Europe/Warsaw Europe/Prague Europe/Athens Europe/Bucharest ' +
  'Europe/Sofia Europe/Kyiv Europe/Istanbul Europe/Moscow Africa/Cairo Africa/Johannesburg Africa/Lagos Africa/Nairobi ' +
  'Africa/Casablanca Asia/Dubai Asia/Tehran Asia/Karachi Asia/Kolkata Asia/Kathmandu Asia/Dhaka Asia/Bangkok Asia/Jakarta ' +
  'Asia/Singapore Asia/Shanghai Asia/Hong_Kong Asia/Seoul Asia/Tokyo Asia/Manila Australia/Perth Australia/Adelaide ' +
  'Australia/Sydney Australia/Brisbane Pacific/Auckland Pacific/Honolulu Pacific/Chatham America/Anchorage ' +
  'America/Los_Angeles America/Denver America/Phoenix America/Chicago America/New_York America/Toronto America/Mexico_City ' +
  'America/Bogota America/Sao_Paulo America/Argentina/Buenos_Aires America/Halifax America/St_Johns'
).split(' ');

export const LABELS = [
  'bug', 'feature', 'chore', 'docs', 'design', 'backend', 'frontend', 'urgent',
  'blocked', 'security', 'performance', 'ux', 'infra', 'billing', 'research',
];

export const SEED_CURRENCIES: readonly { code: string; maxMinor: number }[] = [
  { code: 'USD', maxMinor: 5_000_000 },
  { code: 'EUR', maxMinor: 5_000_000 },
  { code: 'GBP', maxMinor: 2_000_000 },
  { code: 'JPY', maxMinor: 900_000 },
  { code: 'KWD', maxMinor: 9_000_000 },
];

const FIRST = ['Ana', 'Bo', 'Cy', 'Dana', 'Eli', 'Fay', 'Gus', 'Hana', 'Ivo', 'Jun', 'Kai', 'Lea', 'Mo', 'Nia', 'Oskar', 'Pia', 'Quinn', 'Rui', 'Sana', 'Teo'];
const LAST = ['Ionescu', 'Novak', 'Silva', 'Tanaka', 'Okafor', 'Larsen', 'Moreau', 'Kowalski', 'Haddad', 'Ruiz', 'Park', 'Weber'];
const VERBS = ['Fix', 'Add', 'Refactor', 'Investigate', 'Document', 'Remove', 'Optimise', 'Review', 'Migrate', 'Test', 'Design', 'Update'];
const ADJECTIVES = ['login', 'billing', 'search', 'export', 'mobile', 'admin', 'webhook', 'invoice', 'onboarding', 'reporting', 'checkout', 'profile'];
const NOUNS = ['redirect', 'page', 'flow', 'endpoint', 'timeout', 'banner', 'cache', 'query', 'form', 'dashboard', 'email', 'permissions', 'layout', 'import'];
const PHRASES = [
  'Reproduced on staging.', 'Looks good to me.', 'Can we split this into two tasks?', 'Blocked by the API change.',
  'Customer reported this again today.', 'Deployed the fix behind a flag.', 'Needs a design review first.',
  'Added a regression test.', 'Moving this to next sprint.', 'The logs show a timeout after 30 seconds.',
  'Please check the latest build.', 'Works in Chrome, fails in Safari.', 'Pairing on this tomorrow morning.',
  'Updated the estimate after investigation.', 'Closing once QA signs off.', 'Root cause is a missing index.',
];

const MS_PER_DAY = 86_400_000;
const foldCache = new Map<string, string>();

export function createRng(seed: number): Rng {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function between(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

export function pick<T>(rng: Rng, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)];
}

export function chance(rng: Rng, probability: number): boolean {
  return rng() < probability;
}

export function sampleDistinct<T>(rng: Rng, items: readonly T[], count: number): T[] {
  const chosen = new Set<number>();
  while (chosen.size < Math.min(count, items.length)) chosen.add(Math.floor(rng() * items.length));

  return [...chosen].map((i) => items[i]);
}

export function memoFold(text: string): string {
  let folded = foldCache.get(text);
  if (folded === undefined) {
    folded = fold(text);
    foldCache.set(text, folded);
  }

  return folded;
}

export function personName(index: number): string {
  return `${FIRST[index % FIRST.length]} ${LAST[Math.floor(index / FIRST.length) % LAST.length]} ${index + 1}`;
}

export function taskTitle(rng: Rng): string {
  return `${pick(rng, VERBS)} ${pick(rng, ADJECTIVES)} ${pick(rng, NOUNS)}`;
}

export function taskDescription(rng: Rng): string {
  return `${pick(rng, PHRASES)} ${pick(rng, PHRASES)}`;
}

export function commentBody(rng: Rng): string {
  return pick(rng, PHRASES);
}

export function seedLabels(rng: Rng): string[] {
  return sampleDistinct(rng, LABELS, between(rng, 0, 3));
}

export function shiftedDate(now: number, days: number): string {
  return new Date(now + days * MS_PER_DAY).toISOString().slice(0, 10);
}

export function days(n: number): number {
  return n * MS_PER_DAY;
}
