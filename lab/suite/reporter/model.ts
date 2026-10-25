import { CHANGE_REQUESTS, crLevel, type CrId, type CrMode } from '../lib/cr-mode.ts';

export type Status = 'pass' | 'fail' | 'skip' | 'todo';
export type Kind = 'happy' | 'trap' | 'errors' | 'other';
export type Classification = 'not_implemented' | 'wrong' | 'untested_but_works' | 'caught_by_own_tests' | null;

export interface TestResult {
  name: string;
  file: string;
  trapId?: string;
  trapIds?: string[];
  category: string;
  suite: 'v1' | CrId;
  kind: Kind;
  status: Status;
  durationMs: number;
  message: string;
  diagnostics?: string[];
  classification?: Classification;
}

export interface Stats {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  passRate: number | null;
}

export const TRAP_IDS = [
  'A1', 'A2', 'A3', 'A4', 'A5', 'A6',
  'B1', 'B2', 'B3', 'B4', 'B5',
  'C1', 'C2', 'C3',
  'D1', 'D2', 'D3', 'D4', 'D5', 'D6',
  'E1', 'E2', 'E3', 'E4', 'E5',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6',
  'G1', 'G2', 'G3', 'G4',
  'H1', 'H2',
  'I1', 'I2', 'I3', 'I4', 'I5', 'I6',
  'J1',
  'K1',
  'L1', 'L2', 'L3',
] as const;

export const TRAP_CATEGORIES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'] as const;

export const CATEGORY_TITLES: Record<string, string> = {
  A: 'Concurrency',
  B: 'Time',
  C: 'Pagination',
  D: 'Authorization',
  E: 'Soft delete',
  F: 'Webhook delivery',
  G: 'Exactly-once side effects',
  H: 'Numbers',
  I: 'Input and validation',
  J: 'Rate limiting',
  K: 'Search',
  L: 'Controlled ambiguities',
  smoke: 'Smoke (happy path)',
  errors: 'Endpoint error coverage',
  other: 'Other',
  'CR-1': 'CR-1 Organizations',
  'CR-2': 'CR-2 UUIDv7 public identifiers',
  'CR-3': 'CR-3 Audit log',
};

// PHASE2.md acceptance criteria keep their number; letter ids are failure-mode probes derived from each CR's
// Specification. `[CRn-H]` names are endpoint happy paths (kind happy) and carry no trap id.
export const CR_TRAPS: Record<CrId, Record<string, string>> = {
  'CR-1': {
    'CR1-1': 'Setup migrates every v1 workspace into its own free organization',
    'CR1-2': 'Workspace plan limit; a plan change by billing lifts it',
    'CR1-3': 'org_admin reads any org workspace as viewer and cannot write',
    'CR1-4': 'Org removal cascades to workspaces with unassignment by the remover',
    'CR1-5': 'Org removal of a workspace owner is 409 sole_owner and changes nothing',
    'CR1-6': 'Per-organization request bucket',
    'CR1-7': 'Org webhooks: cross-workspace creation order, one delivery in flight',
    'CR1-R': 'Org role table',
    'CR1-S': 'No cross-organization leaks',
    'CR1-L': 'Member and webhook limits; lowering a plan keeps data',
    'CR1-O': 'Org lifecycle and invariants (single org_owner, owners are org members, delete/restore, transfer)',
    'CR1-EV': 'Org activity feed, org events and digest organizations',
  },
  'CR-2': {
    'CR2-1': 'Legacy integer read path with Deprecation and Sunset',
    'CR2-2': 'Legacy ids rejected on mutating requests',
    'CR2-3': 'Integer ids return 404 after the sunset instant',
    'CR2-4': 'Same-millisecond ordering is deterministic across pages',
    'CR2-5': 'Webhook payload ids and legacy_ids',
    'CR2-6': 'Legacy integers in GET filters',
    'CR2-U': 'Every id is a lowercase UUIDv7 (bodies, payloads, emails, headers, dedupe keys)',
    'CR2-T': 'UUIDv7 timestamp equals the application clock at creation, or created_at for migrated rows',
    'CR2-M': 'Pre-migration idempotency records and cursors',
  },
  'CR-3': {
    'CR3-1': 'Update entry: diff, versions and request id',
    'CR3-2': 'No entry for replays and rejected requests',
    'CR3-3': 'Member removal: one entry per unassigned task plus the membership, one request id',
    'CR3-4': 'Audit visibility: viewer 403, removed member 404, deleted resources stay visible to admins',
    'CR3-5': 'Worker deliveries audited as system; secrets redacted',
    'CR3-6': 'Retention purge on the application clock',
    'CR3-7': 'Audit paging stable under concurrent writes',
    'CR3-8': 'Export: exactly-once email and NDJSON download',
    'CR3-9': 'X-Request-Id on mutations; write latency with auditing',
    'CR3-M': 'Every mutation audited with the action vocabulary',
    'CR3-F': 'Audit filters and cursor binding',
    'CR3-S': 'Organization and personal audit scope and permissions',
  },
};

export function activeCrs(mode: CrMode): CrId[] {
  return CHANGE_REQUESTS.filter((cr) => crLevel(cr) <= crLevel(mode));
}

export function trapIdsFor(mode: CrMode): string[] {
  return [...TRAP_IDS, ...activeCrs(mode).flatMap((cr) => Object.keys(CR_TRAPS[cr]))];
}

const CR_TAG = /^\[CR([1-3])-([A-Z0-9]+)\]/;

function classifyCr(match: RegExpExecArray): Pick<TestResult, 'trapId' | 'trapIds' | 'category' | 'suite' | 'kind'> {
  const cr = `CR-${match[1]}` as CrId;
  if (match[2] === 'H') return { category: cr, suite: cr, kind: 'happy' };
  const trapId = `CR${match[1]}-${match[2]}`;

  return { trapId, trapIds: [trapId], category: cr, suite: cr, kind: 'trap' };
}

export function classify(name: string): Pick<TestResult, 'trapId' | 'trapIds' | 'category' | 'suite' | 'kind'> {
  const cr = CR_TAG.exec(name);
  if (cr) return classifyCr(cr);
  if (/^\[SMOKE-\d+\]/.test(name)) return { category: 'smoke', suite: 'v1', kind: 'happy' };
  if (/^\[ERR\]/.test(name)) return { category: 'errors', suite: 'v1', kind: 'errors' };
  const tags = [...name.matchAll(/\[([A-L]\d+)\]/g)].map((m) => m[1]);
  if (tags.length && name.startsWith(`[${tags[0]}]`)) {
    return { trapId: tags[0], trapIds: tags, category: tags[0][0], suite: 'v1', kind: 'trap' };
  }

  return { category: 'other', suite: 'v1', kind: 'other' };
}

export function stats(tests: readonly TestResult[]): Stats {
  const passed = tests.filter((t) => t.status === 'pass').length;
  const failed = tests.filter((t) => t.status === 'fail').length;
  const skipped = tests.length - passed - failed;
  const executed = passed + failed;

  return { total: tests.length, passed, failed, skipped, passRate: executed ? round(passed / executed) : null };
}

function round(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

function trapVerdict(s: Stats): 'pass' | 'fail' | 'partial' | 'skipped' | 'uncovered' {
  if (s.total === 0) return 'uncovered';
  if (s.passed + s.failed === 0) return 'skipped';
  if (s.failed === 0) return 'pass';

  return s.passed === 0 ? 'fail' : 'partial';
}

export function summarize(tests: readonly TestResult[], mode: CrMode = 'none') {
  const by = (pred: (t: TestResult) => boolean): Stats => stats(tests.filter(pred));
  const crs = activeCrs(mode);
  const byCategory: Record<string, Stats> = {};
  for (const c of [...TRAP_CATEGORIES, 'smoke', 'errors', 'other', ...CHANGE_REQUESTS]) {
    const s = by((t) => t.category === c);
    if (s.total || c.length === 1 || (crs as string[]).includes(c)) byCategory[c] = s;
  }
  const trapIds = trapIdsFor(mode);
  const byTrap: Record<string, Stats & { verdict: string }> = {};
  for (const id of trapIds) {
    const s = by((t) => (t.trapIds ?? []).includes(id));
    byTrap[id] = { ...s, verdict: trapVerdict(s) };
  }
  const byCr: Record<string, Stats> = { v1: by((t) => t.suite === 'v1') };
  for (const cr of crs) byCr[cr] = by((t) => t.suite === cr);

  return {
    cr: mode,
    byCr,
    totals: stats(tests),
    kinds: {
      happy: by((t) => t.kind === 'happy'),
      trap: by((t) => t.kind === 'trap'),
      errors: by((t) => t.kind === 'errors'),
    },
    byCategory,
    byTrap,
    uncoveredTraps: trapIds.filter((id) => byTrap[id].total === 0),
  };
}

export type Summary = ReturnType<typeof summarize>;

export interface ResultsFile {
  generatedAt: string;
  complete: boolean;
  baseUrl: string | null;
  passRateDefinition: string;
  summary: Summary;
  harnessErrors: { file: string; message: string }[];
  tests: TestResult[];
}
