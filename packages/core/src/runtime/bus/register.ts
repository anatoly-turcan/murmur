import type { RunContext } from '../../model/context.ts';
import { PieceDefinitionError } from '../../model/errors.ts';
import { validateName, validatePieceId } from '../../model/names.ts';
import { isZodSchema } from '../../model/schema.ts';
import { markLifecycleSettled } from '../context.ts';
import { DuplicateResponderError, ShutdownError } from '../errors.ts';
import type { Subscription } from '../transport.ts';
import type { BusContract } from './contracts.ts';
import { dispatcher } from './dispatch.ts';
import { drainEmits } from './emit-scope.ts';
import { mergePolicy } from './policy.ts';
import { handlerKind } from './reply.ts';
import { inSequence, type BusState, type PieceEntry } from './state.ts';
import type { LifecycleHook, PieceHandlerEntry, PieceRuntime, Registration } from './types.ts';

function indexHandlers(runtime: PieceRuntime): Map<string, PieceHandlerEntry> {
  validatePieceId(runtime.name);
  const byName = new Map<string, PieceHandlerEntry>();
  for (const entry of runtime.handlers) {
    validateName(entry.contract.name);

    if (!isZodSchema(entry.contract.payload)) {
      throw new PieceDefinitionError(
        `piece ${runtime.name}: ${entry.contract.name} has no zod payload schema`,
      );
    }

    if (byName.has(entry.contract.name)) {
      throw new PieceDefinitionError(
        `piece ${runtime.name}: more than one handler for ${entry.contract.name}`,
      );
    }

    byName.set(entry.contract.name, entry);
  }

  return byName;
}

function claimResponders(state: BusState, piece: string, contracts: readonly BusContract[]): () => void {
  const requests = contracts.filter((contract) => handlerKind(contract) === 'responder').map((c) => c.name);
  for (const name of requests) {
    const owner = state.responders.get(name);
    if (owner !== undefined && owner !== piece) {
      throw new DuplicateResponderError(name, [owner, piece]);
    }
  }

  const claimed = requests.filter((name) => !state.responders.has(name));
  for (const name of claimed) {
    state.responders.set(name, piece);
  }

  return () => {
    for (const name of claimed) {
      state.responders.delete(name);
    }
  };
}

function subscribePiece(state: BusState, piece: PieceEntry): Promise<Subscription> {
  return state.transport.subscribe([...piece.byName.keys()], piece.name, dispatcher(state, piece), {
    prefetch: piece.policy.concurrency,
  });
}

function lifecycleRun(state: BusState, piece: string, signal: AbortSignal): RunContext {
  return { traceId: state.ids.uuid(), hop: -1, piece, signal, internal: false };
}

// ALS carries the hook's run into timers and sockets it opens; once the hook settles they get background roots
async function runHook(
  state: BusState,
  piece: PieceEntry,
  hook: LifecycleHook,
  signal: AbortSignal,
): Promise<void> {
  const run = lifecycleRun(state, piece.name, signal);
  const emits: Promise<void>[] = [];
  let settled = false;
  const scope = { state, piece, run, emits, isLate: () => settled };
  state.scopes.set(run, scope);

  try {
    await state.context.run(run, async () => {
      await hook();
      await drainEmits(emits);
    });
  } finally {
    settled = true;
    state.scopes.delete(run);
    markLifecycleSettled(run);
  }
}

async function runHooks(
  state: BusState,
  piece: PieceEntry,
  hooks: readonly LifecycleHook[],
  signal: AbortSignal,
): Promise<void> {
  await inSequence(hooks, (hook) => runHook(state, piece, hook, signal));
}

function groupOf(id: string): string {
  return id.slice(0, Math.max(id.lastIndexOf('/'), 0));
}

function announceStarted(state: BusState, piece: PieceEntry): void {
  const { runtime } = piece;
  state.sys(
    'piece.started',
    {
      piece: piece.name,
      group: groupOf(piece.name),
      handles: runtime.handlers.map((h) => ({ name: h.contract.name, kind: handlerKind(h.contract) })),
      emits: runtime.emits.map((c) => c.name),
      needs: [...(runtime.needs ?? [])],
      configKeys: [...(runtime.configKeys ?? [])],
      policy: piece.policy,
    },
    { source: piece.name },
  );
}

function entryFor(
  state: BusState,
  runtime: PieceRuntime,
  byName: Map<string, PieceHandlerEntry>,
): PieceEntry {
  return {
    runtime,
    name: runtime.name,
    policy: mergePolicy(state.policy, runtime.policy),
    byName,
    declared: new Set(runtime.emits.map((c) => c.name)),
    replyIgnored: false,
    active: 0,
    waiting: [],
  };
}

export async function registerPiece(state: BusState, runtime: PieceRuntime): Promise<Registration> {
  if (state.stopping.signal.aborted) {
    throw new ShutdownError(`piece ${runtime.name}: the bus is stopping`);
  }

  const byName = indexHandlers(runtime);
  const release = claimResponders(
    state,
    runtime.name,
    [...byName.values()].map((h) => h.contract),
  );
  const piece = entryFor(state, runtime, byName);

  const subscription = await subscribePiece(state, piece).catch((error: unknown) => {
    release();
    throw error;
  });

  state.subscriptions.defer(() => subscription.unsubscribe());
  state.pieces.set(piece.name, piece);
  const registration: Registration = {
    piece: piece.name,
    subscription,
    start: async () => {
      await runHooks(state, piece, runtime.start, state.stopping.signal);
      announceStarted(state, piece);
    },
    stop: async (signal) => {
      await runHooks(state, piece, runtime.stop, signal);
      state.sys('piece.stopped', { piece: piece.name }, { source: piece.name });
    },
    [Symbol.asyncDispose]: () => subscription.unsubscribe(),
  };
  state.registrations.push(registration);

  return registration;
}
