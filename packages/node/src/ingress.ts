import {
  describePiece,
  MurmurError,
  parseWire,
  type Bus,
  type HandlerEntry,
  type IngressPort,
  type IngressTarget,
  type JobTarget,
  type PieceClass,
  type Schema,
} from 'murmur';

import type { PieceDefinition } from './loader/class-piece.ts';
import type { SysPublisher } from './sys.ts';

export interface ServingPiece {
  readonly name: string;
  readonly definition: PieceDefinition;
}

interface JobHandler {
  readonly piece: string;
  readonly entry: HandlerEntry;
  readonly instance: () => object;
}

export interface PortDeps {
  readonly pieces: readonly ServingPiece[];
  readonly instance: (name: string) => object;
  readonly bus: Bus;
  readonly sys: SysPublisher;
  readonly ready: Promise<void>;
  readonly claimsJobs: boolean;
}

export function ingressTargets(
  piece: string,
  pieceClass: PieceClass,
  instance: () => object,
): IngressTarget[] {
  return describePiece(pieceClass).serves.map((serve) => ({ piece, serve, instance }));
}

function targetsOf(piece: ServingPiece, instance: (name: string) => object): IngressTarget[] {
  return ingressTargets(piece.name, piece.definition.pieceClass, () => instance(piece.name));
}

export function servedTargets(
  pieces: readonly ServingPiece[],
  instance: (name: string) => object,
): IngressTarget[] {
  return pieces.flatMap((piece) => targetsOf(piece, instance));
}

function jobHandlers(deps: PortDeps): Map<string, JobHandler> {
  const handlers = deps.pieces.flatMap((piece) =>
    describePiece(piece.definition.pieceClass)
      .handlers.filter((entry) => entry.contract.kind === 'command')
      .map((entry) => ({ piece: piece.name, entry, instance: () => deps.instance(piece.name) })),
  );

  return new Map(handlers.map((handler) => [handler.entry.contract.wireName, handler]));
}

function jobTarget(bus: Bus, contract: string, handler: JobHandler): JobTarget {
  const policy = bus.policyOf(handler.piece);

  return {
    contract,
    piece: handler.piece,
    timeoutMs: policy.timeoutMs,
    retry: handler.entry.retry,
    policyRetry: policy.retry,
    every: handler.entry.every,
  };
}

function handlerFor(handlers: ReadonlyMap<string, JobHandler>, contract: string): JobHandler {
  const handler = handlers.get(contract);
  if (handler === undefined) {
    throw new MurmurError(`jobs: no piece in this process handles ${contract}`, { retryable: false });
  }

  return handler;
}

export function ingressPort(deps: PortDeps): IngressPort {
  const targets = servedTargets(deps.pieces, deps.instance);
  const handlers = jobHandlers(deps);
  const { bus } = deps;

  return {
    targets: (transport) => targets.filter((target) => target.serve.binding.transport === transport),
    invoke: (piece, init, fn) => bus.invoke(piece, init, fn),
    ready: deps.ready,
    jobTargets: () =>
      deps.claimsJobs ? [...handlers].map(([contract, handler]) => jobTarget(bus, contract, handler)) : [],
    invokeLocal: (contract, input, init) => {
      const handler = handlerFor(handlers, contract);
      const { entry } = handler;

      return bus.invoke(
        handler.piece,
        { transport: 'job', binding: contract, payload: Object(input), ...init },
        async (delivery) => {
          const value = await parseWire(contract, 'payload', entry.contract.input as Schema, input);
          const target = handler.instance();

          return entry.get(target).call(target, value, delivery);
        },
      );
    },
    report: (name, payload) => deps.sys(name, payload),
  };
}
