import type { Analysis } from '../analysis/analyze.ts';
import type { ContractInfo } from '../analysis/types.ts';
import { usageError } from '../errors.ts';
import type { ClassPiecePlan, HandleSpec, NeedSpec, ServeSpec } from './class-piece-model.ts';
import { pascalName, type KeyType } from './names.ts';

export interface ClassPieceRequest {
  readonly root: string;
  readonly id: string;
  readonly handles: readonly ContractInfo[];
  readonly emits: readonly ContractInfo[];
  readonly needs: readonly string[];
  readonly config: readonly KeyType[];
  readonly serves: readonly string[];
  readonly edge: boolean;
  readonly idempotent: boolean;
  readonly summary: string | null;
}

export type ContractLookup = (ref: string) => ContractInfo;

const VERBS = new Set(['get', 'post', 'put', 'patch', 'delete']);
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

export function parseNeeds(list: readonly string[]): NeedSpec[] {
  return list.map((item) => {
    const [field = '', cap = field] = item.split('=').map((s) => s.trim());
    if (!IDENTIFIER.test(field) || !IDENTIFIER.test(cap)) {
      throw usageError(`--needs: "${item}" needs field=capability (like db=sqlite)`);
    }

    return { field, cap };
  });
}

export function parseServe(raw: string, lookup: ContractLookup): ServeSpec {
  const match = /^(\w+)\s+(\/\S*?)(?:=(\S+))?$/.exec(raw.trim());
  const verb = match?.[1]?.toLowerCase() ?? '';

  if (match === null || !VERBS.has(verb)) {
    throw usageError(`--serve: "${raw}" needs '<get|post|put|patch|delete> /path[=Contract]'`);
  }

  const ref = match[3];

  return { verb, path: match[2] as string, contract: ref === undefined ? null : lookup(ref) };
}

export function handleSpec(analysis: Analysis, contract: ContractInfo): HandleSpec {
  const { app } = analysis.statics;
  const fact = app.contracts.find((c) => c.wireName === contract.name);
  const model = fact === undefined ? null : app.modelIn(fact);

  if (fact === undefined || model === null || model.file !== fact.file || fact.outputType === null) {
    return { contract, outputType: null, outputModel: null };
  }

  return { contract, outputType: fact.outputType, outputModel: model.className };
}

function classNameFor(id: string, taken: ReadonlySet<string>): string {
  const base = pascalName(id.split('/').at(-1) ?? id);

  return taken.has(base) ? `${base}Piece` : base;
}

function takenNames(handles: readonly HandleSpec[], others: readonly ContractInfo[]): Set<string> {
  const contracts = [...handles.map((h) => h.contract), ...others];

  return new Set([...contracts.map((c) => c.className), ...handles.flatMap((h) => h.outputModel ?? [])]);
}

function checkShape(
  request: ClassPieceRequest,
  needs: readonly NeedSpec[],
  serves: readonly ServeSpec[],
): void {
  if (request.edge && serves.length === 0) {
    throw usageError('--edge needs at least one --serve route');
  }

  if (request.edge && request.handles.length > 0) {
    throw usageError('an edge serves routes and requests contracts; drop --edge or --handles');
  }

  if (request.idempotent && !needs.some((n) => n.cap === 'sqlite')) {
    throw usageError('--idempotent claims envelope ids in sqlite; add --needs db=sqlite');
  }
}

export function classPiecePlan(
  analysis: Analysis,
  request: ClassPieceRequest,
  lookup: ContractLookup,
): ClassPiecePlan {
  const needs = parseNeeds(request.needs);
  const serves = request.serves.map((raw) => parseServe(raw, lookup));
  checkShape(request, needs, serves);
  const handles = request.handles.map((c) => handleSpec(analysis, c));
  const taken = takenNames(handles, [...request.emits, ...serves.flatMap((s) => s.contract ?? [])]);

  return {
    root: request.root,
    id: request.id,
    className: classNameFor(request.id, taken),
    handles,
    emits: request.emits,
    needs,
    config: request.config,
    serves,
    idempotent: request.idempotent,
    summary: request.summary,
  };
}
