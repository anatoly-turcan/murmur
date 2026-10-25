import type { ContractInfo } from '../analysis/types.ts';
import { contractSource, type ImportSpec } from './imports.ts';
import { camelName, kebabName, pieceDir, type KeyType } from './names.ts';
import { sampleOf, tsLiteral } from './sample.ts';

export interface NeedSpec {
  readonly field: string;
  readonly cap: string;
}

export interface HandleSpec {
  readonly contract: ContractInfo;
  readonly outputType: string | null;
  readonly outputModel: string | null;
}

export interface ServeSpec {
  readonly verb: string;
  readonly path: string;
  readonly contract: ContractInfo | null;
}

export interface ClassPiecePlan {
  readonly root: string;
  readonly id: string;
  readonly className: string;
  readonly handles: readonly HandleSpec[];
  readonly emits: readonly ContractInfo[];
  readonly needs: readonly NeedSpec[];
  readonly config: readonly KeyType[];
  readonly serves: readonly ServeSpec[];
  readonly idempotent: boolean;
  readonly summary: string | null;
}

export function classDir(plan: ClassPiecePlan): string {
  return pieceDir(plan.root, plan.id);
}

export function isEvent(contract: ContractInfo): boolean {
  return !contract.hasReply;
}

export function requestsOf(plan: ClassPiecePlan): ContractInfo[] {
  return plan.emits.filter((c) => !isEvent(c));
}

export function eventsOf(plan: ClassPiecePlan): ContractInfo[] {
  return plan.emits.filter(isEvent);
}

export function edgeInput(plan: ClassPiecePlan): ContractInfo | null {
  const methodServes = plan.serves.filter((s) => s.contract === null);

  return plan.handles.length === 0 && methodServes.length > 0 ? (requestsOf(plan)[0] ?? null) : null;
}

export function claimsDelivery(plan: ClassPiecePlan, handle: HandleSpec): boolean {
  const kind = handle.contract.kind;

  return plan.idempotent && kind !== 'query' && kind !== 'guard';
}

export function contractImports(plan: ClassPiecePlan, contracts: readonly ContractInfo[]): ImportSpec[] {
  return contracts.map((c) => ({
    from: contractSource(plan.root, classDir(plan), c),
    names: [c.className],
  }));
}

export function methodOfHandle(contract: ContractInfo): string {
  const name = contract.className;

  return isEvent(contract) ? `on${name}` : camelName(name);
}

export function serveKey(serve: ServeSpec): string {
  return `${serve.verb.toUpperCase()} ${serve.path}`;
}

export function fixturePath(contract: ContractInfo): string {
  return `./fixtures/${kebabName(contract.className)}.json`;
}

export function sample(schema: unknown): string {
  return tsLiteral(sampleOf(schema as never));
}
