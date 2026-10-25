import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { ContractViolationError, MurmurError, type PiecePolicy, type ServedBinding } from 'murmur';

import type { AppDefinition } from '../app.ts';
import { clockConfig, OVERRIDABLE_IN_PROD, type ClockSettings } from '../capabilities/clock.ts';
import { jobs } from '../capabilities/jobs.ts';
import {
  addNeededTokens,
  collectCapabilities,
  planCapabilities,
  type CapabilityEntry,
  type LocalCapability,
  type PlannedCapability,
} from '../capabilities/registry.ts';
import { buildEnvMap } from '../config/env-names.ts';
import {
  HEALTHZ_SWITCH,
  INGRESS_SWITCH,
  resolveCapabilityConfig,
  resolveHealthz,
  resolveIngressEnabled,
  resolvePieceConfig,
  resolvePolicy,
  schemaKeys,
  type ConfigInputs,
} from '../config/resolve.ts';
import { emptyYamlConfig, readYamlConfig, type Env, type YamlConfig } from '../config/sources.ts';
import type { BootError, BootErrorCode, BootReport, BootWarning, Catalog, LoadedPiece } from '../types.ts';
import { bindingErrors, catalogRoutes, servedBindings } from './bindings.ts';
import { isValid, type ContractSource, type PieceCandidate, type ValidPiece } from './candidate.ts';
import { buildCatalog, catalogWarnings } from './catalog.ts';
import { classPieceExport, hasSchedules, servedTokens } from './class-piece.ts';
import { discover, type Discovered } from './discover.ts';
import { capabilityOf, contractsOf, importFile, messageOf } from './import.ts';
import { parseFrontmatter, pieceIdOf } from './piece-id.ts';
import { inProcess, selectProcess } from './process.ts';
import { buildReport } from './report.ts';
import {
  checkInternalScope,
  checkNeeds,
  checkResponders,
  contractIdentityErrors,
  pieceIdError,
  requiredCapabilities,
} from './validate.ts';

export interface LoadInputs {
  readonly root: string;
  readonly app: AppDefinition;
  readonly env: Env;
  readonly configFile?: string | undefined;
  readonly process?: string | undefined;
  readonly mode?: 'dev' | 'prod' | undefined;
}

export interface PieceDraft extends Omit<LoadedPiece, 'runtime'> {
  readonly policy: PiecePolicy;
}

export interface LoadResult {
  readonly report: BootReport;
  readonly pieces: readonly PieceDraft[];
  readonly capabilities: readonly PlannedCapability[];
  readonly entries: ReadonlyMap<string, CapabilityEntry>;
  readonly clock: ClockSettings;
  readonly claimsJobs: boolean;
}

interface Stage {
  readonly inputs: LoadInputs;
  readonly errors: BootError[];
  readonly warnings: BootWarning[];
}

const IMPORT_ERROR_CODES: ReadonlySet<string> = new Set([
  'guard-output-overlap',
  'guard-order',
  'guard-meta-unknown',
  'guard-meta-invalid',
]);

function importErrorCode(error: unknown): BootErrorCode | undefined {
  if (error instanceof MurmurError && IMPORT_ERROR_CODES.has(error.code)) {
    return error.code as BootErrorCode;
  }

  return undefined;
}

function importError(error: unknown, file: string, piece?: string): BootError {
  const failure: BootError = { phase: 'load', message: messageOf(error), file };
  const code = importErrorCode(error);

  if (code === undefined) {
    return failure;
  }

  if (piece === undefined) {
    return { ...failure, code };
  }

  return { ...failure, code, piece };
}

async function loadYaml(stage: Stage): Promise<YamlConfig> {
  const file = stage.inputs.configFile ?? join(stage.inputs.root, 'murmur.yaml');

  try {
    return await readYamlConfig(file, stage.inputs.env);
  } catch (error) {
    stage.errors.push({ phase: 'config', message: messageOf(error), file });

    return emptyYamlConfig;
  }
}

async function loadContracts(stage: Stage, found: Discovered, piecesRoot: string): Promise<ContractSource[]> {
  const files = [
    ...found.contracts.map((file) => ({ file, scope: null })),
    ...found.internalContracts.map((file) => ({ file, scope: pieceIdOf(file, piecesRoot) })),
  ];

  const loaded = await Promise.all(
    files.map(async ({ file, scope }) => ({ file, scope, imported: await importFile(file) })),
  );

  return loaded.flatMap(({ file, scope, imported }) => {
    if (!imported.ok) {
      stage.errors.push(importError(imported.error, file));

      return [];
    }

    return contractsOf(imported.module).map((contract) => ({
      contract,
      file,
      visibility: scope === null ? ('public' as const) : ('internal' as const),
      scope: scope === '' ? null : scope,
    }));
  });
}

async function loadLocalCapabilities(stage: Stage, files: readonly string[]): Promise<LocalCapability[]> {
  const loaded = await Promise.all(files.map(async (file) => ({ file, imported: await importFile(file) })));

  return loaded.flatMap(({ file, imported }) => {
    if (!imported.ok) {
      stage.errors.push(importError(imported.error, file));

      return [];
    }

    const definition = capabilityOf(imported.module);
    if (definition !== undefined) {
      return [{ file, definition }];
    }

    const message = 'capability.ts must default-export defineCapability({ name, start, ... })';
    stage.errors.push({ phase: 'load', message, file });

    return [];
  });
}

function newCandidate(file: string, piecesRoot: string): PieceCandidate {
  const id = pieceIdOf(file, piecesRoot);
  const segments = id.split('/');

  return {
    id,
    file,
    dir: dirname(file),
    title: segments.at(-1) ?? id,
    summary: null,
    parent: segments.length > 1 ? segments.slice(0, -1).join('/') : null,
    depth: segments.length - 1,
    definition: undefined,
    errors: [],
    warnings: [],
  };
}

async function readContext(candidate: PieceCandidate): Promise<void> {
  const file = join(candidate.dir, 'context.md');

  try {
    const frontmatter = parseFrontmatter(await readFile(file, 'utf8'));
    candidate.title = frontmatter.title ?? candidate.title;
    candidate.summary = frontmatter.summary;
  } catch (error) {
    const missing = Reflect.get(Object(error), 'code') === 'ENOENT';
    const message = missing ? 'context.md is missing beside piece.ts' : `context.md: ${messageOf(error)}`;
    candidate.errors.push({ phase: 'declaration', message, file });
  }
}

function readPieceExport(candidate: PieceCandidate, module: Record<string, unknown>): void {
  const exported = classPieceExport(candidate.id, module);
  if (exported.ok) {
    candidate.definition = exported.definition;

    return;
  }

  candidate.errors.push({ phase: 'declaration', message: exported.message, file: candidate.file });
}

async function importPiece(candidate: PieceCandidate): Promise<void> {
  const imported = await importFile(candidate.file);
  if (!imported.ok) {
    candidate.errors.push(importError(imported.error, candidate.file, candidate.id));

    return;
  }

  readPieceExport(candidate, imported.module);
}

async function loadPiece(file: string, piecesRoot: string): Promise<PieceCandidate> {
  const candidate = newCandidate(file, piecesRoot);
  const idError = pieceIdError(candidate.id, file);

  if (idError !== undefined) {
    candidate.errors.push(idError);
  }

  await readContext(candidate);
  await importPiece(candidate);

  return candidate;
}

function selected(
  candidates: readonly PieceCandidate[],
  globs: readonly string[] | undefined,
): PieceCandidate[] {
  const sorted = candidates.toSorted((a, b) => a.id.localeCompare(b.id));

  return globs === undefined ? sorted : sorted.filter((c) => inProcess(c.id, globs));
}

function validatePieces(
  stage: Stage,
  pieces: readonly ValidPiece[],
  sources: readonly ContractSource[],
  entries: ReadonlyMap<string, CapabilityEntry>,
): void {
  stage.errors.push(...contractIdentityErrors(sources, pieces, [...entries.values()]));
  checkInternalScope(pieces, sources);
  checkResponders(pieces);
  checkNeeds(pieces, new Set(entries.keys()));
}

function envCollisions(
  stage: Stage,
  pieces: readonly ValidPiece[],
  planned: readonly CapabilityEntry[],
): void {
  const map = buildEnvMap(
    pieces.map((p) => ({ id: p.id, keys: Object.keys(p.definition.config) })),
    planned.map((c) => ({ name: c.name, keys: schemaKeys(c.definition.config) })),
  );

  for (const { envVar, subjects } of map.collisions) {
    stage.errors.push({
      phase: 'config',
      code: 'config-env-collision',
      message: `${envVar} is claimed by ${subjects.join(' and ')}`,
    });
  }
}

function configError(error: unknown, file: string | undefined): BootError {
  const issues = error instanceof ContractViolationError ? { issues: [...error.issues] } : {};

  return { phase: 'config', message: messageOf(error), ...(file === undefined ? {} : { file }), ...issues };
}

function mergePolicy(declared: PiecePolicy, override: PiecePolicy): PiecePolicy {
  const retry =
    declared.retry === undefined && override.retry === undefined
      ? {}
      : { retry: { ...declared.retry, ...override.retry } };

  return { ...declared, ...override, ...retry };
}

async function draftPiece(piece: ValidPiece, yaml: YamlConfig, env: Env): Promise<PieceDraft> {
  const { definition } = piece;
  const resolved = await resolvePieceConfig(piece.id, definition.config, { env, yaml });
  piece.errors.push(...resolved.errors.map((e) => configError(e, piece.file)));

  const override = await resolvePolicy(piece.id, yaml.pieces[piece.id]?.['$policy']).catch(
    (error: unknown) => {
      piece.errors.push(configError(error, piece.file));

      return {};
    },
  );

  return {
    name: piece.id,
    title: piece.title,
    summary: piece.summary,
    parent: piece.parent,
    depth: piece.depth,
    file: piece.file,
    dir: piece.dir,
    definition,
    config: resolved.config,
    needs: [...definition.needs],
    policy: mergePolicy(definition.policy, override),
  };
}

interface IngressUse {
  readonly served: ReadonlySet<string>;
  readonly needed: ReadonlySet<string>;
}

function ingressUse(pieces: readonly ValidPiece[], needed: readonly string[]): IngressUse {
  const served = pieces.flatMap((piece) => servedTokens(piece.definition).map((token) => token.name));

  return { served: new Set(served), needed: new Set(needed) };
}

function hasHealthz(entry: CapabilityEntry): boolean {
  return entry.definition.ingress === true && schemaKeys(entry.definition.config).includes(HEALTHZ_SWITCH);
}

async function healthzOnly(
  stage: Stage,
  entries: ReadonlyMap<string, CapabilityEntry>,
  yaml: YamlConfig,
): Promise<string[]> {
  const inputs = { env: stage.inputs.env, yaml };

  const forced = await Promise.all(
    [...entries.values()]
      .filter(hasHealthz)
      .map(async (entry) =>
        (await resolveHealthz(entry.name, inputs).catch(() => true)) ? [entry.name] : [],
      ),
  );

  return forced.flat();
}

async function offReason(
  entry: CapabilityEntry,
  inputs: ConfigInputs,
  use: IngressUse,
): Promise<string | undefined> {
  if (entry.definition.ingress !== true) {
    return undefined;
  }

  if (!(await resolveIngressEnabled(entry.name, inputs))) {
    return `${INGRESS_SWITCH} is false`;
  }

  if (!use.served.has(entry.name) && !use.needed.has(entry.name)) {
    return hasHealthz(entry)
      ? `no loaded piece serves through it (capabilities.${entry.name}.${HEALTHZ_SWITCH}: true listens for /healthz only)`
      : 'no loaded piece serves through it';
  }

  return undefined;
}

async function planEntry(
  entry: CapabilityEntry,
  inputs: ConfigInputs,
  use: IngressUse,
): Promise<PlannedCapability> {
  const reserved = entry.definition.ingress === true ? [INGRESS_SWITCH] : [];
  const config = await resolveCapabilityConfig(entry.name, entry.definition.config, inputs, reserved);
  const off = await offReason(entry, inputs, use);

  return off === undefined ? { ...entry, config } : { ...entry, config, off };
}

async function planConfig(
  stage: Stage,
  planned: readonly CapabilityEntry[],
  yaml: YamlConfig,
  use: IngressUse,
): Promise<PlannedCapability[]> {
  const inputs = { env: stage.inputs.env, yaml };

  return Promise.all(
    planned.map(async (entry) => {
      try {
        return await planEntry(entry, inputs, use);
      } catch (error) {
        stage.errors.push(configError(error, entry.file));

        return { ...entry, config: undefined };
      }
    }),
  );
}

function usageWarnings(
  stage: Stage,
  pieces: readonly ValidPiece[],
  entries: ReadonlyMap<string, CapabilityEntry>,
  planned: readonly CapabilityEntry[],
  yaml: YamlConfig,
): void {
  for (const piece of pieces.filter((p) => p.summary === null)) {
    piece.warnings.push({
      code: 'missing-summary',
      subject: piece.id,
      pieces: [piece.id],
      message: `${piece.id}: context.md has no summary in its frontmatter`,
    });
  }

  const used = new Set(planned.map((c) => c.name));
  for (const entry of [...entries.values()].filter((e) => e.origin !== 'builtin' && !used.has(e.name))) {
    stage.warnings.push({
      code: 'capability-unused',
      subject: entry.name,
      pieces: [],
      message: `capability ${entry.name} is defined but no piece needs it`,
    });
  }

  const byId = new Map(pieces.map((p) => [p.id, p]));
  for (const [id, values] of Object.entries(yaml.pieces)) {
    const piece = byId.get(id);
    if (piece === undefined && stage.inputs.process !== undefined) {
      continue;
    }

    const declared = piece === undefined ? [] : Object.keys(piece.definition.config);
    for (const key of Object.keys(values).filter((k) => k !== '$policy' && !declared.includes(k))) {
      const warning: BootWarning = {
        code: 'config-key-unused',
        subject: `${id}.${key}`,
        pieces: piece === undefined ? [] : [id],
        message: `murmur.yaml pieces.${id}.${key} matches no declared config key`,
      };
      const target = piece?.warnings ?? stage.warnings;
      target.push(warning);
    }
  }
}

function attachWarnings(
  warnings: readonly BootWarning[],
  candidates: readonly PieceCandidate[],
  stage: Stage,
): void {
  for (const warning of warnings) {
    const owners = candidates.filter((c) => warning.pieces.includes(c.id));
    if (owners.length === 0) {
      stage.warnings.push(warning);
    }

    for (const owner of owners) {
      owner.warnings.push(warning);
    }
  }
}

async function clockSettings(stage: Stage, yaml: YamlConfig): Promise<ClockSettings> {
  try {
    const settings = (await resolveCapabilityConfig('clock', clockConfig, {
      env: stage.inputs.env,
      yaml,
    })) as ClockSettings;

    if (settings.overridable && stage.inputs.mode === 'prod') {
      stage.warnings.push({
        code: 'clock-overridable-prod',
        subject: 'clock',
        pieces: [],
        message: OVERRIDABLE_IN_PROD,
      });
    }

    return settings;
  } catch (error) {
    stage.errors.push(configError(error, undefined));

    return { overridable: false };
  }
}

function usesJobs(piece: ValidPiece): boolean {
  return piece.definition.needs.includes(jobs.name) || hasSchedules(piece.definition);
}

function appJobs(entries: Map<string, CapabilityEntry>, discovered: readonly ValidPiece[]): string[] {
  if (!discovered.some(usesJobs)) {
    return [];
  }

  if (!entries.has(jobs.name)) {
    entries.set(jobs.name, { name: jobs.name, definition: jobs, file: undefined, origin: 'builtin' });
  }

  return [jobs.name];
}

function withRoutes(catalog: Catalog, served: readonly ServedBinding[]): Catalog {
  if (served.length === 0) {
    return catalog;
  }

  return { ...catalog, routes: catalogRoutes(served) };
}

export async function loadApp(inputs: LoadInputs): Promise<LoadResult> {
  const stage: Stage = { inputs, errors: [], warnings: [] };
  const piecesDir = inputs.app.pieces ?? 'pieces';
  const piecesRoot = join(inputs.root, piecesDir);
  const yaml = await loadYaml(stage);
  const found = await discover(inputs.root, piecesDir);
  const sources = await loadContracts(stage, found, piecesRoot);
  const local = await loadLocalCapabilities(stage, found.capabilities);
  const discovered = await Promise.all(found.pieces.map((file) => loadPiece(file, piecesRoot)));
  const selection = selectProcess(
    inputs.app,
    inputs.process,
    discovered.map((c) => c.id),
  );
  stage.errors.push(...selection.errors);
  const candidates = selected(discovered, selection.globs);

  const { entries, errors: registryErrors } = collectCapabilities(inputs.app.capabilities, local);
  stage.errors.push(...registryErrors);
  const pieces = candidates.filter(isValid);
  addNeededTokens(entries, pieces);
  validatePieces(stage, pieces, sources, entries);
  const served = servedBindings(pieces);
  stage.errors.push(...bindingErrors(served));
  const clock = await clockSettings(stage, yaml);
  const scheduled = appJobs(entries, discovered.filter(isValid));

  const needed = [
    ...new Set([
      ...requiredCapabilities(pieces, new Set(entries.keys())),
      ...scheduled,
      ...(clock.overridable ? ['sqlite'] : []),
      ...(await healthzOnly(stage, entries, yaml)),
    ]),
  ];

  const plan = planCapabilities(entries, needed);
  stage.errors.push(...plan.errors);
  envCollisions(stage, pieces, plan.order);
  const drafts = await Promise.all(pieces.map((piece) => draftPiece(piece, yaml, inputs.env)));
  const capabilities = await planConfig(stage, plan.order, yaml, ingressUse(pieces, needed));
  const catalog = withRoutes(buildCatalog(sources, pieces, plan.order), served);
  usageWarnings(stage, pieces, entries, plan.order, yaml);
  attachWarnings(catalogWarnings(catalog), candidates, stage);
  const report = buildReport(candidates, stage.errors, stage.warnings, catalog);

  return { report, pieces: drafts, capabilities, entries, clock, claimsJobs: selection.claimsJobs };
}
