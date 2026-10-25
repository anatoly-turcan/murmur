import { existsSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

import { validateName } from 'murmur';

import { readPackageImports } from './app-files.ts';
import {
  extractFile,
  type ClassKind,
  type ContractFact,
  type FileFacts,
  type GuardFact,
  type TokenFact,
} from './extract.ts';
import { readSource } from './source-checks.ts';
import type { ContractFile, Repo } from './types.ts';

export interface StaticContract {
  readonly wireName: string | null;
  readonly nameError: string | null;
  readonly className: string;
  readonly kind: ClassKind;
  readonly file: string;
  readonly visibility: 'public' | 'internal';
  readonly scope: string | null;
  readonly fields: readonly string[] | null;
  readonly nested: Readonly<Record<string, string | null>>;
  readonly requiredFields: readonly string[] | null;
  readonly output: string | null;
  readonly outputType: string | null;
  readonly guard: GuardFact | null;
  readonly line: number;
}

export interface StaticToken {
  readonly file: string;
  readonly name: string;
  readonly transport: 'http' | null;
  readonly guards: readonly string[];
  readonly errors: TokenFact['errors'];
  readonly inputErrors: TokenFact['inputErrors'];
  readonly issueCodes: TokenFact['issueCodes'];
  readonly idempotencyErrors: TokenFact['idempotencyErrors'];
  readonly customEnvelope: boolean;
  readonly responseHeaders: boolean;
  readonly log: boolean;
}

export interface ImportOrigin {
  readonly specifier: string;
  readonly file: string | null;
}

export interface TokenRef {
  readonly name: string;
  readonly http: StaticToken | null;
}

export interface StaticApp {
  readonly root: string;
  readonly contracts: readonly StaticContract[];
  readonly tokens: readonly StaticToken[];
  facts(file: string): FileFacts;
  contractIn(file: string, identifier: string): StaticContract | null;
  tokenIn(file: string, identifier: string): TokenRef | null;
  importIn(file: string, identifier: string): ImportOrigin | null;
  modelIn(contract: StaticContract): StaticContract | null;
}

interface Target {
  readonly file: string | null;
  readonly specifier: string;
  readonly imported: string;
}

const TS_EXTENSIONS = ['', '.ts', '/index.ts'];

export function domainOf(root: string, file: string): string | null {
  const parts = relative(root, file).split(sep);
  const stem = basename(file).replace(/\.[cm]?ts$/, '');
  const dirs = parts.slice(1, -1);

  if (parts[0] === 'contracts') {
    return [...dirs, stem].join('.');
  }

  if (parts[0] === 'pieces' && stem === 'contracts' && dirs.length > 0) {
    return dirs.join('.');
  }

  return null;
}

function nameProblem(
  root: string,
  file: string,
  fact: ContractFact,
): { wireName: string | null; nameError: string | null } {
  const domain = domainOf(root, file);
  const where = relative(root, file);

  if (fact.explicitName === null && domain === null) {
    return {
      wireName: null,
      nameError: `cannot derive a wire name for ${fact.className} from ${where}: define it in contracts/ or pieces/<group>/contracts.ts, or pass { name }`,
    };
  }

  const wireName = fact.explicitName ?? `${domain}.${fact.className}`;

  try {
    validateName(wireName);

    return { wireName, nameError: null };
  } catch (error) {
    return { wireName: null, nameError: `${fact.className} in ${where}: ${(error as Error).message}` };
  }
}

function contractOf(root: string, source: ContractFile, fact: ContractFact): StaticContract {
  return {
    ...nameProblem(root, source.file, fact),
    className: fact.className,
    kind: fact.kind,
    file: source.file,
    visibility: source.visibility,
    scope: source.scope,
    fields: fact.fields,
    nested: fact.nested,
    requiredFields: fact.requiredFields,
    output: fact.output,
    outputType: fact.outputType,
    guard: fact.guard,
    line: fact.line,
  };
}

function existing(path: string): string | null {
  return TS_EXTENSIONS.map((ext) => `${path}${ext}`).find((candidate) => existsSync(candidate)) ?? null;
}

function aliasTarget(imports: Readonly<Record<string, string>>, specifier: string): string | null {
  for (const [pattern, target] of Object.entries(imports)) {
    const star = pattern.indexOf('*');
    if (star === -1 && pattern === specifier) {
      return target;
    }

    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);

    if (star !== -1 && specifier.startsWith(prefix) && specifier.endsWith(suffix)) {
      return target.replace('*', specifier.slice(prefix.length, specifier.length - suffix.length));
    }
  }

  return null;
}

function resolveSpecifier(
  root: string,
  aliases: Readonly<Record<string, string>>,
  from: string,
  specifier: string,
): string | null {
  if (specifier.startsWith('.')) {
    return existing(resolve(dirname(from), specifier));
  }

  if (!specifier.startsWith('#')) {
    return null;
  }

  const target = aliasTarget(aliases, specifier);

  return target === null ? null : existing(join(root, target));
}

function staticToken(file: string, fact: TokenFact): StaticToken {
  const folder = basename(dirname(file));

  return {
    file,
    name: fact.name ?? (fact.factory === 'http' ? 'web' : folder),
    transport: fact.factory === 'http' ? 'http' : null,
    guards: fact.guards,
    errors: fact.errors,
    inputErrors: fact.inputErrors,
    issueCodes: fact.issueCodes,
    idempotencyErrors: fact.idempotencyErrors,
    customEnvelope: fact.customEnvelope,
    responseHeaders: fact.responseHeaders,
    log: fact.log,
  };
}

interface StaticContext {
  readonly root: string;
  readonly aliases: Readonly<Record<string, string>>;
  readonly facts: (file: string) => FileFacts;
  readonly contracts: readonly StaticContract[];
}

const MAX_REEXPORT_HOPS = 8;

function factsCache(): (file: string) => FileFacts {
  const cache = new Map<string, FileFacts>();

  return (file) => {
    const known = cache.get(file);
    if (known !== undefined) {
      return known;
    }

    const extracted = extractFile(file, readSource(file) ?? '');
    cache.set(file, extracted);

    return extracted;
  };
}

function importTarget(context: StaticContext, file: string, identifier: string): Target | null {
  for (const entry of context.facts(file).imports) {
    const match = entry.entries.find((e) => e.local === identifier);
    if (match !== undefined) {
      return {
        file: resolveSpecifier(context.root, context.aliases, file, entry.specifier),
        specifier: entry.specifier,
        imported: match.imported,
      };
    }
  }

  return null;
}

function localContract(root: string, facts: FileFacts, className: string): StaticContract | null {
  const fact = facts.contracts.find((c) => c.className === className);
  if (fact === undefined) {
    return null;
  }

  return contractOf(root, { file: facts.file, visibility: 'public', scope: null }, fact);
}

function reexported(context: StaticContext, file: string, name: string, hops: number): StaticContract | null {
  const entry = context.facts(file).reexports.find((r) => r.exported === name);
  const from =
    entry === undefined ? null : resolveSpecifier(context.root, context.aliases, file, entry.specifier);

  if (entry === undefined || from === null || hops >= MAX_REEXPORT_HOPS) {
    return null;
  }

  return declaredIn(context, from, entry.imported, hops + 1);
}

function declaredIn(
  context: StaticContext,
  file: string,
  className: string,
  hops = 0,
): StaticContract | null {
  return (
    context.contracts.find((c) => c.file === file && c.className === className) ??
    localContract(context.root, context.facts(file), className) ??
    reexported(context, file, className, hops)
  );
}

function contractIn(context: StaticContext, file: string, identifier: string): StaticContract | null {
  const local = declaredIn(context, file, identifier);
  if (local !== null) {
    return local;
  }

  const found = importTarget(context, file, identifier);
  if (found === null || found.file === null) {
    return null;
  }

  return declaredIn(context, found.file, found.imported);
}

function tokenIn(context: StaticContext, file: string, identifier: string): TokenRef | null {
  const found = importTarget(context, file, identifier);
  if (found === null) {
    return null;
  }

  if (found.file === null) {
    return { name: found.imported, http: null };
  }

  const fact = context.facts(found.file).tokens.find((t) => t.bindings.includes(found.imported));
  if (fact === undefined) {
    return null;
  }

  const token = staticToken(found.file, fact);

  return { name: token.name, http: token.transport === 'http' ? token : null };
}

export function buildStaticApp(repo: Repo): StaticApp {
  const { root } = repo;
  const facts = factsCache();
  const contracts = repo.contractFiles.flatMap((source) =>
    facts(source.file).contracts.map((fact) => contractOf(root, source, fact)),
  );
  const tokens = repo.capabilityFiles.flatMap((file) =>
    facts(file).tokens.map((fact) => staticToken(file, fact)),
  );
  const context: StaticContext = { root, aliases: readPackageImports(root), facts, contracts };

  return {
    root,
    contracts,
    tokens,
    facts,
    contractIn: (file, identifier) => contractIn(context, file, identifier),
    tokenIn: (file, identifier) => tokenIn(context, file, identifier),
    importIn: (file, identifier) => importTarget(context, file, identifier),
    modelIn: (contract) =>
      contract.output === null ? null : contractIn(context, contract.file, contract.output),
  };
}
