import { matchesGlob } from 'node:path';

import { processNoPieceProblem } from 'murmur';

import type { Analysis } from './analyze.ts';
import type { Catalog, ContractView, ProcessView } from './types.ts';

export interface Crossing {
  readonly kind: 'request' | 'event';
  readonly piece: string;
  readonly contract: string;
  readonly missing: readonly string[];
  readonly elsewhere: readonly string[];
}

const START = 'pnpm exec murmur start';

export function hostsOf(processes: readonly ProcessView[], id: string): string[] {
  return processes
    .filter((entry) => entry.globs.some((glob) => matchesGlob(id, glob)))
    .map((entry) => entry.name);
}

function hostsOfAll(processes: readonly ProcessView[], ids: readonly string[]): string[] {
  return [...new Set(ids.flatMap((id) => hostsOf(processes, id)))].toSorted();
}

function requestsOf(catalog: Catalog, id: string): string[] {
  const own = catalog.pieces.find((piece) => piece.name === id)?.requests ?? [];
  const guards = catalog.routes.filter((route) => route.piece === id).flatMap((route) => route.guards);

  return [...new Set([...own, ...guards])];
}

function pieceEmitters(contract: ContractView): string[] {
  return contract.emitters.filter((emitter) => !emitter.startsWith('('));
}

function requestCrossings(catalog: Catalog, processes: readonly ProcessView[]): Crossing[] {
  const byName = new Map(catalog.contracts.map((contract) => [contract.name, contract]));

  return catalog.pieces.flatMap((piece) => {
    const hosts = hostsOf(processes, piece.name);

    return requestsOf(catalog, piece.name).flatMap((name): Crossing[] => {
      const handlers = byName.get(name)?.handlers ?? [];
      const elsewhere = hostsOfAll(processes, handlers);
      const missing = hosts.filter((host) => !elsewhere.includes(host));

      if (handlers.length === 0 || missing.length === 0) {
        return [];
      }

      return [{ kind: 'request', piece: piece.name, contract: name, missing, elsewhere }];
    });
  });
}

function eventCrossings(catalog: Catalog, processes: readonly ProcessView[]): Crossing[] {
  return catalog.contracts
    .filter((contract) => contract.kind === 'event')
    .flatMap((contract) => {
      const elsewhere = hostsOfAll(processes, pieceEmitters(contract));

      return contract.handlers.flatMap((piece): Crossing[] => {
        const hosts = hostsOf(processes, piece);
        if (elsewhere.length === 0 || hosts.length === 0 || hosts.some((host) => elsewhere.includes(host))) {
          return [];
        }

        return [{ kind: 'event', piece, contract: contract.name, missing: hosts, elsewhere }];
      });
    });
}

function splitProcesses(analysis: Analysis): readonly ProcessView[] | null {
  const { processes, transport } = analysis.description;

  return processes === null || transport !== 'memory' ? null : processes;
}

export function crossings(analysis: Analysis): Crossing[] {
  const processes = splitProcesses(analysis);
  if (processes === null) {
    return [];
  }

  return [...requestCrossings(analysis.catalog, processes), ...eventCrossings(analysis.catalog, processes)];
}

export function emptyProcesses(analysis: Analysis): string[] {
  const ids = analysis.catalog.pieces.map((piece) => piece.name);

  return (analysis.description.processes ?? [])
    .filter((entry) => !ids.some((id) => entry.globs.some((glob) => matchesGlob(id, glob))))
    .map((entry) => processNoPieceProblem(entry.name, entry.globs, ids));
}

function names(list: readonly string[]): string {
  return list.map((name) => `\`${name}\``).join(', ');
}

export function crossingMessage(crossing: Crossing): string {
  const { piece, contract, missing, elsewhere } = crossing;
  if (crossing.kind === 'event') {
    return `${piece} subscribes ${contract}, emitted only in ${names(elsewhere)}; on the memory transport events stay in one process; use \`this.jobs.enqueue\` for cross-process work`;
  }

  const handled =
    elsewhere.length === 0 ? 'handled in no process' : `handled only in process ${names(elsewhere)}`;

  return `${piece} requests ${contract}, ${handled}; host the handler in ${names(missing)} too, or make the work a job (\`this.jobs.enqueue\`)`;
}

function reach(analysis: Analysis, id: string, host: string): string {
  const requests = requestsOf(analysis.catalog, id);
  const unreached = crossings(analysis)
    .filter((c) => c.kind === 'request' && c.piece === id && c.missing.includes(host))
    .map((c) => c.contract);

  if (requests.length === 0 || splitProcesses(analysis) === null) {
    return `\`${host}\``;
  }

  if (unreached.length === 0) {
    return `\`${host}\` (requests: all ${requests.length} handled here)`;
  }

  return `\`${host}\` (requests not handled here: ${names(unreached)})`;
}

export function processLine(analysis: Analysis, id: string): string | null {
  const { processes } = analysis.description;
  if (processes === null) {
    return null;
  }

  const hosts = hostsOf(processes, id);
  if (hosts.length === 0) {
    return `- process: none (no defineApp({ processes }) entry lists \`${id}\`; only \`${START}\` without a name loads it)`;
  }

  const run = hosts.length === 1 ? `${START} ${hosts[0] ?? ''}` : `${START} <process>`;

  return `- process: ${hosts.map((host) => reach(analysis, id, host)).join(', ')} · run: \`${run}\``;
}
