import { classPieces, type ClassPieces, type StaticFinding } from './class-pieces.ts';
import { pieceNodes } from './discover.ts';
import { analyzeRoutes, type RouteAnalysis } from './routes.ts';
import { buildStaticApp, type StaticApp, type StaticContract } from './static-app.ts';
import type { ContractInfo, PieceInfo, Repo, RepoDescription } from './types.ts';

export interface StaticAnalysis {
  readonly app: StaticApp;
  readonly classes: ClassPieces;
  readonly routes: RouteAnalysis;
  readonly findings: readonly StaticFinding[];
}

export interface StaticStart {
  readonly app: StaticApp;
  readonly classes: ClassPieces;
}

type ClassContract = StaticContract & {
  readonly wireName: string;
  readonly kind: ContractInfo['kind'] & string;
};

export function startStatics(repo: Repo): StaticStart {
  const app = buildStaticApp(repo);

  return { app, classes: classPieces(repo, app) };
}

function isClassContract(contract: StaticContract): contract is ClassContract {
  return contract.kind !== 'model' && contract.wireName !== null;
}

function describedTwin(
  described: readonly ContractInfo[],
  contract: StaticContract,
): ContractInfo | undefined {
  return described.find((c) => c.file === contract.file && c.exportName === contract.className);
}

function contractInfo(contract: ClassContract, twin: ContractInfo | undefined): ContractInfo {
  return {
    name: contract.wireName,
    exportName: contract.className,
    file: contract.file,
    visibility: contract.visibility,
    scope: contract.scope,
    hasReply: contract.kind !== 'event',
    schema: twin?.schema ?? null,
    schemaError: twin?.schemaError ?? null,
    kind: contract.kind,
    className: contract.className,
    ...(twin?.runtimeName === undefined ? {} : { runtimeName: twin.runtimeName }),
  };
}

function mergedContracts(app: StaticApp, described: readonly ContractInfo[]): ContractInfo[] {
  return app.contracts.filter(isClassContract).map((c) => contractInfo(c, describedTwin(described, c)));
}

function orderedPieces(repo: Repo, described: readonly PieceInfo[], classes: ClassPieces): PieceInfo[] {
  const byId = new Map([...described, ...classes.pieces].map((p) => [p.id, p]));

  return pieceNodes(repo).flatMap((node) => byId.get(node.id) ?? []);
}

function finding(contract: StaticContract, rule: string, message: string): StaticFinding {
  return { rule, severity: 'error', file: contract.file, line: contract.line, col: 1, message };
}

function nameFindings(app: StaticApp, contracts: readonly ContractInfo[]): StaticFinding[] {
  const named = app.contracts.filter((c) => c.kind !== 'model');
  const invalid = named.flatMap((c) => (c.nameError === null ? [] : [finding(c, 'wire-name', c.nameError)]));
  const duplicates = named.flatMap((c, at) => {
    const first = named.findIndex((other) => other.wireName === c.wireName);
    if (c.wireName === null || first === at) {
      return [];
    }

    const other = named[first] as StaticContract;

    return [
      finding(
        c,
        'contract-identity',
        `two contract classes are named ${c.wireName} (${other.className} and ${c.className}): define it once and import it`,
      ),
    ];
  });
  const mismatches = contracts.flatMap((info) => {
    const contract = named.find((c) => c.file === info.file && c.className === info.className);
    if (contract === undefined || info.runtimeName === undefined || info.runtimeName === info.name) {
      return [];
    }

    return [
      finding(
        contract,
        'wire-name-mismatch',
        `${info.className}: the runtime names it ${info.runtimeName}, the static analysis ${info.name}; check that the app root and the contracts/ and pieces/ folders are where murmur expects them`,
      ),
    ];
  });

  return [...invalid, ...duplicates, ...mismatches];
}

export function finishStatics(
  repo: Repo,
  start: StaticStart,
  described: RepoDescription,
): { readonly description: RepoDescription; readonly statics: StaticAnalysis } {
  const contracts = mergedContracts(start.app, described.contracts);
  const pieces = orderedPieces(repo, described.pieces, start.classes);
  const routes = analyzeRoutes(start.app, pieces);

  return {
    description: { ...described, contracts, pieces },
    statics: {
      ...start,
      routes,
      findings: [...start.classes.findings, ...nameFindings(start.app, contracts)],
    },
  };
}
