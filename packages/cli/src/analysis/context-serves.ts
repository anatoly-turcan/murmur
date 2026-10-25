import { IDEMPOTENCY_DEFAULTS } from 'murmur';

import { HEADINGS } from './context-headings.ts';
import type { Section } from './context-sections.ts';
import { capabilityEnvName } from './env-names.ts';
import type { IssueRename } from './extract.ts';
import { joinBlocks, table } from './markdown.ts';
import { guardShape } from './routes.ts';
import type { StaticApp, StaticToken } from './static-app.ts';
import type { PieceInfo, ServeInfo } from './types.ts';

export interface GuardSheet {
  readonly wireName: string;
  readonly className: string;
  readonly model: string;
  readonly fields: readonly string[];
  readonly after: readonly string[];
  readonly optional: readonly string[];
  readonly meta: readonly string[];
}

export interface ServeRow {
  readonly key: string;
  readonly token: string;
  readonly idempotent: string | null;
  readonly guards: readonly string[];
  readonly skipped: readonly GuardSheet[];
  readonly added: readonly GuardSheet[];
  readonly auth: string;
  readonly via: string;
  readonly meta: string | null;
}

export interface InputFailure {
  readonly part: string;
  readonly status: number;
  readonly code: string;
}

export interface TokenSheet {
  readonly name: string;
  readonly guards: readonly GuardSheet[];
  readonly errors: readonly string[];
  readonly inputFailures: readonly InputFailure[];
  readonly issueCodes: readonly IssueRename[];
  readonly idempotency: Readonly<Record<'inProgress' | 'reused', InputFailure>>;
  readonly customEnvelope: boolean;
  readonly responseHeaders: boolean;
  readonly log: boolean;
}

export interface ServesView {
  readonly rows: readonly ServeRow[];
  readonly tokens: readonly TokenSheet[];
  readonly fromLane: boolean;
}

export const DEFAULT_ERRORS = [
  { name: 'PayloadTooLargeError', status: 413, code: 'payload_too_large' },
  { name: 'NoRouteError', status: 501, code: 'not_implemented' },
  { name: 'RequestTimeoutError', status: 504, code: 'timeout' },
  { name: 'HandlerTimeoutError', status: 504, code: 'timeout' },
  { name: 'RemoteError', status: 502, code: 'upstream_failed' },
];

export const DEFAULT_INPUT_FAILURES: readonly InputFailure[] = [
  { part: 'params', status: 404, code: 'not_found' },
  { part: 'query', status: 400, code: 'invalid_input' },
  { part: 'headers', status: 400, code: 'invalid_input' },
  { part: 'json', status: 400, code: 'invalid_input' },
  { part: 'mediaType', status: 415, code: 'unsupported_media_type' },
  { part: 'body', status: 400, code: 'invalid_input' },
];

const UNITS: readonly (readonly [number, string])[] = [
  [3_600_000, 'h'],
  [60_000, 'm'],
  [1000, 's'],
];

function durationText(ms: number): string {
  const unit = UNITS.find(([size]) => ms % size === 0);

  return unit === undefined ? `${ms}ms` : `${ms / unit[0]}${unit[1]}`;
}

function idempotentCell(serve: ServeInfo): string | null {
  if (serve.idempotent === null) {
    return null;
  }

  const scope = serve.idempotent.scope.join(', ') || '?';

  return `${scope} · ttl ${durationText(serve.idempotent.ttlMs ?? IDEMPOTENCY_DEFAULTS.ttlMs)}`;
}

function guardSheet(app: StaticApp, wireName: string): GuardSheet {
  const contract = app.contracts.find((c) => c.wireName === wireName);
  const model = contract === undefined ? null : app.modelIn(contract);
  const shape = guardShape(app, wireName);
  const meta = contract?.guard?.meta ?? [];

  return {
    wireName,
    className: contract?.className ?? wireName,
    model: model?.className ?? '?',
    fields: model?.fields ?? [],
    after: shape.after.map((ref) => ref.label),
    optional: shape.optional.map((ref) => ref.label),
    meta: meta.map((m) => (m.fallback === null ? m.key : `${m.key} = ${m.fallback}`)),
  };
}

function authOf(guards: readonly GuardSheet[]): string {
  if (guards.length === 0) {
    return 'undefined';
  }

  return guards.map((guard) => guard.model).join(' & ');
}

function viaOf(serve: ServeInfo): string {
  if (serve.contract === null) {
    return `method ${serve.method ?? ''}`.trim();
  }

  const status = serve.status === null ? '' : ` (${serve.status})`;

  return `→ ${serve.contract}${status}`;
}

function defaultGuards(app: StaticApp, tokenName: string): string[] {
  const token = app.tokens.find((t) => t.name === tokenName);
  if (token === undefined) {
    return [];
  }

  return token.guards.flatMap((identifier) => app.contractIn(token.file, identifier)?.wireName ?? []);
}

function rowOf(app: StaticApp, serve: ServeInfo): ServeRow {
  const guards = serve.guards.map((guard) => guardSheet(app, guard));
  const defaults = defaultGuards(app, serve.token);
  const skipped = defaults.filter((guard) => !serve.guards.includes(guard)).map((g) => guardSheet(app, g));

  return {
    key: serve.key,
    token: serve.token,
    idempotent: idempotentCell(serve),
    guards: guards.map((g) => g.className),
    skipped,
    added: guards.filter((guard) => !defaults.includes(guard.wireName)),
    auth: authOf(guards),
    via: viaOf(serve),
    meta: serve.metaText,
  };
}

function errorLines(token: StaticToken): string[] {
  const overridden = new Set(token.errors.map((e) => e.name));
  const errors = [...DEFAULT_ERRORS.filter((e) => !overridden.has(e.name)), ...token.errors];

  return [...errors.map((e) => `${e.name} → ${e.status} \`${e.code}\``), 'anything else → 500 `internal`'];
}

function inputFailures(token: StaticToken): InputFailure[] {
  return DEFAULT_INPUT_FAILURES.map((fallback) => {
    const set = token.inputErrors.find((e) => e.name === fallback.part);

    return set === undefined ? fallback : { part: fallback.part, status: set.status, code: set.code };
  });
}

function idempotencyFailures(token: StaticToken): TokenSheet['idempotency'] {
  const mapped = (kind: 'inProgress' | 'reused') => {
    const { status, code } =
      token.idempotencyErrors.find((e) => e.name === kind) ?? IDEMPOTENCY_DEFAULTS.errors[kind];

    return { part: kind, status, code };
  };

  return { inProgress: mapped('inProgress'), reused: mapped('reused') };
}

function tokenSheet(app: StaticApp, token: StaticToken): TokenSheet {
  const guards = token.guards.flatMap((identifier) => {
    const wireName = app.contractIn(token.file, identifier)?.wireName ?? null;

    return wireName === null ? [] : [guardSheet(app, wireName)];
  });

  return {
    name: token.name,
    guards,
    errors: errorLines(token),
    inputFailures: inputFailures(token),
    issueCodes: token.issueCodes,
    idempotency: idempotencyFailures(token),
    customEnvelope: token.customEnvelope,
    responseHeaders: token.responseHeaders,
    log: token.log,
  };
}

function laneRow(key: string): ServeRow {
  return {
    key,
    token: '',
    idempotent: null,
    guards: ['?'],
    skipped: [],
    added: [],
    auth: '?',
    via: '?',
    meta: null,
  };
}

function sheetsFor(app: StaticApp, names: ReadonlySet<string> | null): TokenSheet[] {
  const tokens = app.tokens.filter(
    (token) => token.transport === 'http' && (names === null || names.has(token.name)),
  );

  return tokens.map((token) => tokenSheet(app, token));
}

export function servesView(
  app: StaticApp,
  info: PieceInfo | undefined,
  laneKeys: readonly string[],
): ServesView | null {
  const serves = info?.serves ?? [];
  if (serves.length > 0) {
    return {
      rows: serves.map((serve) => rowOf(app, serve)),
      tokens: sheetsFor(app, new Set(serves.map((serve) => serve.token))),
      fromLane: false,
    };
  }

  if (laneKeys.length > 0) {
    return { rows: laneKeys.map(laneRow), tokens: sheetsFor(app, null), fromLane: true };
  }

  return null;
}

const LANE_NOTE =
  'Routes from the serves lane: piece.ts is absent, so guards and handlers are unknown; the token defaults below apply unless a route skips or adds guards.';

function guardLine(guard: GuardSheet, at: number): string {
  const extras = [
    ...(guard.after.length === 0 ? [] : [`after: ${guard.after.join(', ')}`]),
    ...(guard.optional.length === 0 ? [] : [`optional: ${guard.optional.join(', ')}`]),
    ...(guard.meta.length === 0 ? [] : [`meta: ${guard.meta.join(', ')}`]),
  ];
  const head = `${at + 1}. \`${guard.className}\` → \`${guard.model}\` { ${guard.fields.join(', ')} }`;

  return [head, ...extras].join(' · ');
}

function isSet(value: boolean): string {
  return value ? 'set' : 'not set';
}

function admissionText(sheet: TokenSheet): string {
  if (sheet.guards.length === 0) {
    return joinBlocks([`### Admission (${sheet.name})`, '- guards: none (every route is open)']);
  }

  const notes = [
    `- a route fills the guards' meta keys: \`${sheet.name}.patch('/x/:id', { meta: { … } })\`; a key no kept guard reads fails the boot (\`guard-meta-unknown\`); a guard runs after every guard in its \`after\` (\`guard-order\`).`,
    `- responseHeaders(auth): ${isSet(sheet.responseHeaders)} · log(auth): ${isSet(sheet.log)} (one \`access { method, path, status, ms, traceId }\` line per request).`,
  ];

  return joinBlocks([
    `### Admission (${sheet.name})`,
    'Guards run in this order, one at a time, before the body is read; the first `reject(…)` answers and the rest do not run:',
    sheet.guards.map(guardLine).join('\n'),
    notes.join('\n'),
  ]);
}

function bodyShape(sheet: TokenSheet): string {
  if (sheet.customEnvelope) {
    return `the body is the custom \`errors.envelope\` of the ${sheet.name} token`;
  }

  return 'the body is `{ error: { code, message, issues? }, traceId }`';
}

function tokenText(sheet: TokenSheet): string {
  const auth = authOf(sheet.guards);
  const lines = [
    `- \`req: WebRequest\` is \`HttpRequest<${auth}>\`; a route that skips or adds guards spells its auth with class names.`,
    `- \`req.headers\` is a \`Headers\` (names case-insensitive); \`req.peer\` is the socket's remote address; \`req.ip\` is the first \`X-Forwarded-For\` entry when \`capabilities.${sheet.name}.trustProxy: true\` is set in murmur.yaml (or \`${capabilityEnvName(sheet.name, 'trustProxy')}=true\`), else \`req.peer\`.`,
    `- errors: ${sheet.errors.join(', ')}; ${bodyShape(sheet)}.`,
  ];

  return joinBlocks([`### ${sheet.name} defaults`, lines.join('\n'), inputFailuresText(sheet)]);
}

function renamedCode(sheet: TokenSheet, code: string): string {
  return sheet.issueCodes.find((rename) => rename.from === code)?.to ?? code;
}

function sampleFailure(sheet: TokenSheet): string {
  const body = sheet.inputFailures.find((failure) => failure.part === 'body') ?? {
    status: 400,
    code: 'invalid_input',
  };
  const message = 'Too small: expected string to have >=1 characters';
  const issue = {
    path: ['title'],
    code: renamedCode(sheet, 'too_small'),
    message,
    origin: 'string',
    minimum: 1,
    inclusive: true,
  };
  const failure = { code: body.code, message: `title: ${message}`, issues: [issue] };
  const rendered = sheet.customEnvelope
    ? `errors.envelope(${JSON.stringify({ status: body.status, ...failure })})`
    : JSON.stringify({ error: failure, traceId: '…' });

  return `- e.g. \`req.read({ body: { title: z.string().min(1) } })\` with \`{"title":""}\` answers ${body.status}: \`${rendered}\``;
}

function inputFailuresText(sheet: TokenSheet): string {
  const rows = sheet.inputFailures.map((failure) => [
    failure.part,
    String(failure.status),
    `\`${failure.code}\``,
  ]);
  const renames = sheet.issueCodes.map((rename) => `\`${rename.from}\` → \`${rename.to}\``);
  const notes = [
    "- issues keep zod's `code` and params: `{ path, code, message, minimum?, maximum?, keys?, format? }`; a refinement's `params` are spread into its issue, the escape for codes zod cannot tell apart.",
    ...(renames.length === 0 ? [] : [`- issueCodes: ${renames.join(', ')}`]),
    sampleFailure(sheet),
  ];

  return joinBlocks([
    `Input failures (\`errors.input\` of ${sheet.name}): the first failing part of \`req.read\` answers.`,
    table(['part', 'status', 'code'], rows),
    notes.join('\n'),
  ]);
}

export const SERVE_RULES = [
  "- forms: a `→ C` row is a shorthand above the class, `@Serve(web.get('/todos'), C)`: it reads params < query < JSON body into `C`'s input, requests `C` and answers its output like a returned outcome; a `method m` row decorates the method, `@Serve(web.post('/todos')) async m(req: WebRequest): Promise<HttpResult>`. Options are the binding's second argument: `web.delete('/todos/:id', { status: 204 })` (no body), `web.get('/x', { skip: [Guard] })` drops a default guard, `{ guards: [Guard] }` adds one, `web.post('/x', { idempotent: { scope: ['auth.userId', 'ip'] } })` makes client retries that send an `Idempotency-Key` header replay instead of running twice.",
  '- match: a static segment beats `:param`, `:param` beats `/*rest`, segment by segment from the left, then the longer path wins (`/todos/search` before `/todos/:id`); a path served only for other methods answers 405, no path 404.',
  "- read with `const { params, query, headers, body } = await req.read({ params?, query?, headers?, body? })`, each a zod object or shape: parts in that order, the first failing one answers; params/query strings are retried JSON-decoded (`'3'` → 3); the query is strict (unknown or repeated single keys fail, `z.array()` takes repeats); header keys are lower-case, a missing optional header is `null`, and `headers: { 'if-match': IfMatch }` (`IfMatch` from `murmur`) reads a strong ETag to its inner value or `null`; the body needs a JSON content type (else `mediaType`), empty is `{}`.",
  '- answer with `return req.reply(outcome, { status, headers, etag })` or return the outcome; `etag: (body) => body.version` sends a strong ETag and a matching `If-None-Match` on GET answers 304.',
  "- returning: an output (JSON, `status` or the route's), a `Rejection` (rendered unchanged through the envelope, its headers too), a `Response`, `undefined` (204) or `null` (404 `not_found`). Refuse in the edge with `return reject(403, message)`.",
].join('\n');

function guardCell(row: ServeRow): string {
  const changes = [
    ...row.skipped.map((guard) => `skip: [${guard.className}]`),
    ...row.added.map((guard) => `guards: [${guard.className}]`),
    ...(row.meta === null ? [] : [`meta: ${row.meta}`]),
  ];
  const guards = row.guards.join(', ') || '—';

  return changes.length === 0 ? guards : `${guards} (${changes.join(', ')})`;
}

function failureText(failure: InputFailure): string {
  return `${failure.status} \`${failure.code}\``;
}

function idempotencyNote(sheet: TokenSheet): string {
  const { inProgress, reused } = sheet.idempotency;

  return `- idempotent (${sheet.name}): a request with an \`Idempotency-Key\` header runs once per scope (the first listed path with a value); the same key, path, query and body replays the stored 2xx with \`Idempotent-Replayed: true\`, another request answers ${failureText(reused)}, one still running ${failureText(inProgress)}; a non-2xx answer, a throw, an event stream or a body over \`maxBodyBytes\` keeps no row (a retry runs again). Write no idempotency code in the method.`;
}

function routeTable(rows: readonly ServeRow[]): string {
  const idempotent = rows.some((row) => row.idempotent !== null);
  const extra = (row: ServeRow) => (idempotent ? [row.idempotent ?? '—'] : []);

  return table(
    ['key', 'guards', 'auth', 'via', ...(idempotent ? ['idempotent'] : [])],
    rows.map((row) => [row.key, guardCell(row), `\`${row.auth}\``, row.via, ...extra(row)]),
  );
}

export function servesSection(view: ServesView): Section {
  const idempotentTokens = new Set(view.rows.flatMap((row) => (row.idempotent === null ? [] : [row.token])));
  const text = joinBlocks([
    HEADINGS.serves,
    ...view.tokens.map(admissionText),
    routeTable(view.rows),
    ...(view.fromLane ? [LANE_NOTE] : []),
    [SERVE_RULES, ...view.tokens.filter((t) => idempotentTokens.has(t.name)).map(idempotencyNote)].join('\n'),
    ...view.tokens.map(tokenText),
  ]);

  return { id: 'serves', title: 'Serves', priority: 1, render: () => text };
}
