import { signaturesOnly } from './ast.ts';
import { sendersOf } from './catalog.ts';
import { HEADINGS } from './context-headings.ts';
import { rulesText } from './context-rules.ts';
import { servesSection } from './context-serves.ts';
import type { ContextSubject, ContractGroup, FolderFile, SourceFile } from './context-subject.ts';
import { pieceEnvName } from './env-names.ts';
import { LANES, type LaneValue } from './lanes.ts';
import { fence, firstH1Section, joinBlocks, table } from './markdown.ts';
import { catalogCommand, checkCommand, fixCommand, MIGRATE_COMMAND, testCommand } from './piece-commands.ts';
import type { Regeneration } from './regeneration.ts';
import type { Catalog, ContractInfo } from './types.ts';

export type Level = 0 | 1 | 2;

export const INCLUDES = ['code', 'tests', 'fixtures', 'neighbors'] as const;

export type Include = (typeof INCLUDES)[number];

export type Includes = ReadonlySet<Include>;

export interface Section {
  readonly id: string;
  readonly title: string;
  readonly priority: number;
  render(level: Level): string;
}

const PRIVATE_FULL_TEXT_LINES = 300;
const READ_FILES = 'Read the files the task touches; the brief carries what the folder cannot tell you.';

function testsSource(subject: ContextSubject, include: Includes): string[] {
  if (subject.tests.length === 0) {
    return [];
  }

  return [include.has('tests') ? `\`${HEADINGS.tests}\`` : `the tests listed under \`${HEADINGS.files}\``];
}

function writeFrom(subject: ContextSubject, include: Includes): string {
  const sources = [
    `\`${HEADINGS.context}\``,
    `\`${HEADINGS.contracts}\``,
    `\`${HEADINGS.capabilities}\``,
    ...testsSource(subject, include),
  ];

  return `write it from ${sources.slice(0, -1).join(', ')} and ${sources.at(-1) ?? ''}`;
}

const SOURCE_LABEL: Readonly<Record<LaneValue['source'], string>> = {
  catalog: 'catalog',
  'catalog-snapshot': 'catalog snapshot',
  'context.md': 'context.md',
  tests: 'tests',
  none: 'no source',
};

function laneLine(name: string, lane: LaneValue, regeneration: Regeneration): string {
  const values = lane.values.length === 0 ? '(none)' : lane.values.map((v) => `\`${v}\``).join(', ');
  const { snapshot } = regeneration;
  const when =
    lane.source === 'catalog-snapshot' && snapshot !== null
      ? ` (written by murmur ${snapshot.writer} at ${snapshot.writtenAt})`
      : '';

  return `- ${name}: ${values} ← ${SOURCE_LABEL[lane.source]}${when}`;
}

function laneLabel(lane: string): string {
  return lane === 'listens' ? 'handles' : lane;
}

function leafEvidence(subject: ContextSubject): string {
  const found = [
    ...(subject.ownContext === null ? [] : ['context.md']),
    ...(subject.tests.length === 0 ? [] : ['tests']),
  ];

  return found.join(' and ');
}

function regenerationLines(subject: ContextSubject, regeneration: Regeneration, include: Includes): string[] {
  const from = writeFrom(subject, include);
  const why =
    regeneration.reason === 'withheld'
      ? '> regeneration: piece.ts withheld (--withhold-code); private files left out.'
      : `> leaf under regeneration: no piece.ts, the folder has ${leafEvidence(subject)}; private files left out.`;

  return [
    `${why} ${from.charAt(0).toUpperCase()}${from.slice(1)}.`,
    LANES.map((lane) => laneLine(laneLabel(lane), regeneration.lanes[lane], regeneration)).join('\n'),
  ];
}

function usesSqlite(subject: ContextSubject): boolean {
  return subject.schema !== null || subject.capabilities.some((sheet) => sheet.name === 'sqlite');
}

function commandLines(subject: ContextSubject): string {
  const firstContract = subject.contracts[0]?.contracts[0]?.name;

  return [
    `- dir: \`pieces/${subject.id}/\``,
    `- test: \`${testCommand(subject.id)}\``,
    `- fix: \`${fixCommand(subject.id)}\` (oxfmt + lint autofix, e.g. blank lines; run it before check)`,
    `- check: \`${checkCommand(subject.id)}\``,
    ...(firstContract === undefined ? [] : [`- catalog: \`${catalogCommand(firstContract)}\``]),
    ...(usesSqlite(subject)
      ? [`- migrate: \`${MIGRATE_COMMAND}\` (applies the capabilities.sqlite.migrations list once)`]
      : []),
    ...(subject.processLine === null ? [] : [subject.processLine]),
  ].join('\n');
}

function laneValues(values: readonly string[]): string {
  return values.length === 0 ? '(none)' : values.map((v) => `\`${v}\``).join(', ');
}

function classLanes(subject: ContextSubject, catalog: Catalog): string[] {
  const view = catalog.pieces.find((p) => p.name === subject.id);
  if (subject.regeneration !== null || view === undefined) {
    return [];
  }

  return [
    [
      `- class: \`${view.className ?? '?'}\` · kind: ${view.kind}`,
      `- needs: ${laneValues(view.needFields)}`,
      `- handles: ${laneValues(view.handles)}`,
      `- emits: ${laneValues(view.emits)}`,
      `- requests: ${laneValues(view.requests)}`,
      `- serves: ${laneValues(view.serves)}`,
      ...(view.schedules.length === 0 ? [] : [`- schedules: ${laneValues(view.schedules)}`]),
    ].join('\n'),
  ];
}

function importLines(subject: ContextSubject): string[] {
  if (subject.node.kind === 'group' && subject.regeneration === null) {
    return [];
  }

  const block = `imports (keep what the code uses):\n\n${fence('ts', subject.imports.join('\n'))}`;

  return subject.importNote === null ? [block] : [block, subject.importNote];
}

function kindLines(subject: ContextSubject, include: Includes): string[] {
  if (subject.regeneration !== null) {
    return regenerationLines(subject, subject.regeneration, include);
  }

  if (subject.node.kind === 'group') {
    return ['> group folder: no piece.ts; its pieces are its children'];
  }

  return [];
}

function header(subject: ContextSubject, catalog: Catalog, include: Includes): Section {
  const { id, node } = subject;
  const text = joinBlocks([
    `# Piece: ${id} — ${node.title}`,
    `> ${node.summary ?? '(no summary in context.md frontmatter)'}`,
    commandLines(subject),
    ...classLanes(subject, catalog),
    ...kindLines(subject, include),
    ...importLines(subject),
  ]);

  return { id: 'header', title: 'Header', priority: 0, render: () => text };
}

function rules(subject: ContextSubject): Section {
  const text = rulesText(subject.sizingDoc);

  return { id: 'rules', title: 'Rules', priority: 0, render: () => text };
}

function chain(subject: ContextSubject): Section {
  return {
    id: 'context-chain',
    title: 'Context chain',
    priority: 2,
    render: (level) =>
      joinBlocks([
        HEADINGS.context,
        ...subject.chain.map(
          (file) =>
            `### ${file.path} (group)\n\n${level === 0 ? file.source.trim() : firstH1Section(file.source)}`,
        ),
      ]),
  };
}

function relativeLines(subject: ContextSubject): string {
  if (subject.relatives.length === 0) {
    return '';
  }

  const lines = subject.relatives.map((r) => `- ${r.kind} \`${r.id}\` — ${r.summary ?? '(no summary)'}`);

  return `${HEADINGS.relatives}\n\n${lines.join('\n')}`;
}

function ownContext(subject: ContextSubject): Section {
  const own =
    subject.ownContext ?? '(context.md missing — write it first: what, why, listens/emits, invariants)';
  const text = joinBlocks([`### pieces/${subject.id}/context.md`, own.trim(), relativeLines(subject)]);

  return { id: 'context', title: 'Context', priority: 0, render: () => text };
}

function codeHint(subject: ContextSubject, include: Includes): string {
  if (subject.regeneration?.reason === 'withheld') {
    return `piece.ts withheld — ${writeFrom(subject, include)}; its lanes are in the header.`;
  }

  if (subject.regeneration?.reason === 'absent') {
    return `piece.ts absent — ${writeFrom(subject, include)}; its lanes are in the header.`;
  }

  if (subject.pieceSource === null) {
    return `no piece.ts: a group folder; its pieces are listed under \`${HEADINGS.relatives}\`.`;
  }

  return fence('ts', subject.pieceSource);
}

function folderFileLine(file: FolderFile): string {
  const lines = file.lines === 1 ? 'line' : 'lines';

  return `- \`${file.path}\` · ${file.lines} ${lines} · ${file.tokens} tokens`;
}

function files(subject: ContextSubject): Section[] {
  const ownContextFile = `pieces/${subject.id}/context.md`;
  if (subject.files.every((file) => file.path === ownContextFile)) {
    return [];
  }

  const text = joinBlocks([HEADINGS.files, subject.files.map(folderFileLine).join('\n'), READ_FILES]);

  return [{ id: 'files', title: 'Files', priority: 0, render: () => text }];
}

function pieceCode(subject: ContextSubject, include: Includes): Section {
  const text = joinBlocks([HEADINGS.code, HEADINGS.pieceFile, codeHint(subject, include)]);

  return { id: 'piece', title: 'piece.ts', priority: 0, render: () => text };
}

function privateFile(file: SourceFile, level: Level): string {
  const long = file.source.split('\n').length > PRIVATE_FULL_TEXT_LINES;
  const shrink = level === 2 || (level === 1 && long);
  const text = shrink ? (signaturesOnly(file.path, file.source) ?? file.source) : file.source;

  return `### ${file.path}\n\n${fence('ts', text)}`;
}

function privateFiles(subject: ContextSubject): Section {
  return {
    id: 'private',
    title: 'Private files',
    priority: 1,
    render: (level) => joinBlocks(subject.privateFiles.map((file) => privateFile(file, level))),
  };
}

function keyCount(schema: unknown): number {
  const properties = (schema as { properties?: Record<string, unknown> } | null)?.properties;

  return properties === undefined ? 0 : Object.keys(properties).length;
}

function outputLabel(contract: ContractInfo): string {
  if (!contract.hasReply || contract.kind === 'guard') {
    return '';
  }

  const title = (contract.schema?.reply as { title?: unknown } | undefined)?.title;

  return `, ${typeof title === 'string' ? title : `{…${keyCount(contract.schema?.reply)} keys}`}`;
}

function collapsedClass(contract: ContractInfo): string {
  const input = `{…${keyCount(contract.schema?.payload)} keys}`;
  const factory = `${(contract.kind ?? '').charAt(0).toUpperCase()}${(contract.kind ?? '').slice(1)}`;
  const output = outputLabel(contract);

  return `export class ${contract.exportName} extends ${factory}(${input}${output}) {}`;
}

const GUARD_INPUT_NOTE = [
  'Guard input: `headers, params, peer, ip, meta, prior`.',
  '- `input.headers` (lower-case names) and `input.params` (path params) of the request; `input.peer` is the socket address, `input.ip` the client IP.',
  "- `input.meta` is the route's `meta` parsed by this guard's `meta` shape, defaults applied.",
  '- `input.prior` holds the outputs of the guards in `after` (always there) and `optional` (each field `| undefined`).',
  '- refuse with `return reject(status, message, { code, details, headers })`; `headers` (e.g. `retry-after`) go on the response.',
].join('\n');

function handlesGuardIn(subject: ContextSubject, group: ContractGroup): boolean {
  const handled = new Set(subject.info?.handlers.map((h) => h.contract) ?? []);

  return group.contracts.some((c) => c.kind === 'guard' && handled.has(c.name));
}

function contracts(subject: ContextSubject): Section {
  return {
    id: 'contracts',
    title: 'Contracts',
    priority: 1,
    render: (level) =>
      joinBlocks([
        HEADINGS.contracts,
        ...(subject.contracts.length === 0 ? ['(no contracts)'] : []),
        ...subject.contracts.map((group) => {
          const names = group.contracts.map((c) => c.exportName).join(', ');
          const code = level === 0 ? group.code.join('\n\n') : group.contracts.map(collapsedClass).join('\n');

          const note = handlesGuardIn(subject, group) ? `\n\n${GUARD_INPUT_NOTE}` : '';

          return `### ${group.label} → ${names}\n\n${fence('ts', code)}${note}`;
        }),
      ]),
  };
}

function libSection(subject: ContextSubject): Section[] {
  if (subject.lib.length === 0) {
    return [];
  }

  const text = joinBlocks([
    HEADINGS.lib,
    ...subject.lib.map((use) => `### ${use.id}.ts → \`${use.alias}\`\n\n${fence('ts', use.signatures)}`),
  ]);

  return [{ id: 'lib', title: 'Lib', priority: 2, render: () => text }];
}

function kindColumn(contract: Catalog['contracts'][number]): string {
  if (contract.kind === 'command' && contract.enqueuers.length > 0) {
    return 'job';
  }

  return contract.kind ?? (contract.hasReply ? 'request' : 'event');
}

function routeRows(subject: ContextSubject, catalog: Catalog): string {
  const rows = catalog.routes
    .filter((route) => route.piece === subject.id)
    .map((route) => [
      route.token,
      route.key,
      route.method ?? `→ ${route.contract ?? '?'}`,
      route.guards.join(', ') || '—',
    ]);

  return rows.length === 0 ? '' : table(['token', 'route', 'via', 'guards'], rows);
}

function catalogRows(subject: ContextSubject, catalog: Catalog): Section {
  const names = new Set(subject.contracts.flatMap((g) => g.contracts.map((c) => c.name)));
  const rows = catalog.contracts
    .filter((c) => names.has(c.name))
    .map((c) => [c.name, kindColumn(c), sendersOf(c).join(', ') || '—', c.handlers.join(', ') || '—']);
  const warnings = catalog.warnings
    .filter((w) => w.pieces.includes(subject.id) || w.subject === subject.id)
    .map((w) => `- ⚠ ${w.code}: ${w.message}`);
  const columns = ['contract', 'kind', 'requested / emitted by', 'handled by'];
  const text = joinBlocks([
    HEADINGS.catalog,
    rows.length === 0 ? '(no contracts)' : table(columns, rows),
    routeRows(subject, catalog),
    warnings.join('\n'),
  ]);

  return { id: 'catalog', title: 'Catalog', priority: 1, render: () => text };
}

const DEFAULT_SHEET = [
  HEADINGS.defaults,
  '',
  '- `this.log.debug|info|warn|error(message, data?)`, `this.log.child(fields)`: structured, trace-tagged.',
  '- `this.clock.now()` → `Temporal.Instant` (`toString()` is the ISO form to store, `epochMilliseconds` the number); `zonedNow(tz?)`; `sleep(ms, signal?)`.',
  '- All framework time is this clock: kv windows and `ttlMs`, envelope `ts`, deadlines.',
  '- `await this.clock.freeze(instant)`, `advance(ms)`, `clear()` move it only under `capabilities.clock.overridable: true` (murmur.yaml, test environments; a warning in prod): the instant lives in `murmur_clock`, every process on the file sees it, read once per delivery. Otherwise they throw.',
  '- `this.ids.uuid()`; `this.ids.short()` → 8 chars [a-z0-9].',
  '- Always on the piece, never declared in `needs`.',
  '- Pure helpers from `@murmur/node/lib`: `cursor.encode(binding, position)` / `cursor.decode(binding, raw, Position)` (`Position` a zod schema of the position) for lists that take `...Paging({ max })` and answer `Page(Model)` (a tampered, foreign or wrongly shaped cursor decodes to a 400 `invalid_cursor` Rejection to return; the keyset `WHERE` is yours), `bearer`, `canonicalJson`, `sha256`.',
].join('\n');

const TESTS_HINT = [
  HEADINGS.testsHint,
  '',
  "- `await using t = await testPiece(P)` fakes every need left out of `needs`: sqlite → `fakeSqlite({ schema: 'app' })` (the app's migrations; `needs: { db: await fakeSqlite({ schema: 'own' }) }` for this folder's `schema.sql` only), jobs → rows on that faked sqlite (a rolled-back transaction keeps none; `t.enqueued(C)` → `[{ input, options }]`, `await t.runJobs()` runs the due ones through this piece), kv, fetch (pass `fakeFetch(handler)`). `t.needs.<field>` is the handle; `await t.reset()` forgets emits, requests, log and jobs; `t.log`, `t.ids`, `t.clock` (frozen at `now`; `freeze/advance/clear` also move `fakeKv` windows).",
  "- `t.fetch(request, { auth })` skips the route's guards. Admission (guards, `meta`, 401/429, idempotency) is tested on `await using app = await createTestApp()`: every piece over HTTP on a temp migrated database, `app.fetch('/path', init)`, `app.db`, `await app.reset()` (app tables, jobs, idempotency and kv rows, clock override), `await app.clock.freeze(instant)`, `await app.jobs.drain()`.",
].join('\n');

function capabilityDocs(docs: string | null, level: Level): string {
  if (docs === null) {
    return '(no docs page)';
  }

  return level === 0 ? docs.trim() : firstH1Section(docs);
}

function capabilities(subject: ContextSubject): Section {
  return {
    id: 'capabilities',
    title: 'Capabilities',
    priority: 2,
    render: (level) =>
      joinBlocks([
        HEADINGS.capabilities,
        ...subject.capabilities.map((sheet) => {
          const docs = capabilityDocs(sheet.docs, level);
          const block = sheet.interfaceBlock === null ? '' : fence('ts', sheet.interfaceBlock);

          return joinBlocks([`### ${sheet.label}`, docs, block]);
        }),
        DEFAULT_SHEET,
        TESTS_HINT,
      ]),
  };
}

function config(subject: ContextSubject, catalog: Catalog): Section {
  const view = catalog.pieces.find((p) => p.name === subject.id);
  const fromSubject = subject.config.map((k) => ({
    key: k.key,
    type: k.type,
    env: pieceEnvName(subject.id, k.key),
    source: k.hasDefault ? 'default' : 'missing',
  }));
  const keys = view?.config ?? fromSubject;
  const rows = keys.map((k) => [k.key, k.type, `\`${k.env}\``, `pieces.${subject.id}.${k.key}`, k.source]);
  const text = joinBlocks([
    HEADINGS.config,
    rows.length === 0 ? '(no config keys)' : table(['key', 'type', 'env', 'yaml', 'source'], rows),
  ]);

  return { id: 'config', title: 'Config', priority: 1, render: () => text };
}

function testOutline(source: string): string {
  const lines = source.split('\n');
  const outline: string[] = [];
  lines.forEach((line, i) => {
    if (!/\btest\(/.test(line)) {
      return;
    }

    outline.push(line.trim());
    const assertion = lines.slice(i + 1).find((l) => /\bassert\b/.test(l));
    if (assertion !== undefined) {
      outline.push(`  ${assertion.trim()}`);
    }
  });

  return outline.join('\n');
}

function tests(subject: ContextSubject): Section {
  return {
    id: 'tests',
    title: 'Tests',
    priority: 2,
    render: (level) =>
      joinBlocks([
        HEADINGS.tests,
        ...(subject.tests.length === 0 ? ['(no tests)'] : []),
        ...subject.tests.map(
          (file) =>
            `### ${file.path}\n\n${fence('ts', level === 0 ? file.source : testOutline(file.source))}`,
        ),
      ]),
  };
}

function fixtures(subject: ContextSubject): Section {
  return {
    id: 'fixtures',
    title: 'Fixtures',
    priority: 4,
    render: (level) => {
      const files = level === 0 ? subject.fixtures : subject.fixtures.slice(0, 1);
      const body = (file: SourceFile) =>
        level === 0 ? file.source : file.source.split('\n').slice(0, 40).join('\n');

      return joinBlocks([
        HEADINGS.fixtures,
        ...(files.length === 0 ? ['(no fixtures)'] : []),
        ...files.map((file) => `### ${file.path}\n\n${fence('json', body(file))}`),
      ]);
    },
  };
}

function neighbors(subject: ContextSubject): Section {
  return {
    id: 'neighbors',
    title: 'Neighbors',
    priority: 5,
    render: (level) => {
      if (level === 2) {
        return '';
      }

      const lines = subject.neighbors.map((n) =>
        level === 0 ? `- \`${n.id}\` — ${n.paragraph}` : `- \`${n.id}\``,
      );

      return joinBlocks([HEADINGS.neighbors, lines.length === 0 ? '(none)' : lines.join('\n')]);
    },
  };
}

function schemaFile(subject: ContextSubject): Section[] {
  const { schema } = subject;
  if (schema === null) {
    return [];
  }

  const text = joinBlocks([
    HEADINGS.storage,
    `### pieces/${subject.id}/schema.sql`,
    fence('sql', schema.source),
  ]);

  return [{ id: 'storage', title: 'Storage', priority: 1, render: () => text }];
}

function serves(subject: ContextSubject): Section[] {
  return subject.serves === null ? [] : [servesSection(subject.serves)];
}

function code(subject: ContextSubject, include: Includes): Section[] {
  return include.has('code') ? [pieceCode(subject, include), privateFiles(subject)] : [];
}

export function bodySections(subject: ContextSubject, catalog: Catalog, include: Includes): Section[] {
  return [
    header(subject, catalog, include),
    rules(subject),
    chain(subject),
    ownContext(subject),
    ...files(subject),
    ...code(subject, include),
    ...schemaFile(subject),
    contracts(subject),
    ...libSection(subject),
    ...serves(subject),
    catalogRows(subject, catalog),
    capabilities(subject),
    config(subject, catalog),
    ...(include.has('tests') ? [tests(subject)] : []),
    ...(include.has('fixtures') ? [fixtures(subject)] : []),
    ...(include.has('neighbors') ? [neighbors(subject)] : []),
  ];
}
