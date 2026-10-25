import type { Delivery } from '../../model/delivery.ts';
import { answerOf } from '../../model/handle.ts';
import type { HandlerEntry } from '../../model/metadata.ts';
import { describePiece, type PieceClass } from '../../model/piece-class.ts';
import type { PiecePolicy } from '../../model/policy.ts';
import { busContractOf } from './contracts.ts';
import type { PieceHandlerEntry, PieceRuntime } from './types.ts';

export interface ClassPieceInit {
  readonly name: string;
  readonly piece: PieceClass;
  readonly instance: () => object;
  readonly policy?: PiecePolicy | undefined;
  readonly configKeys?: readonly string[] | undefined;
}

type LifecycleHook = 'onStart' | 'onStop';

function handlerOf(entry: HandlerEntry, instance: () => object): PieceHandlerEntry {
  return {
    contract: busContractOf(entry.contract),
    handle: (input: unknown, delivery: Delivery) => {
      const target = instance();

      return answerOf(entry.contract, entry.get(target).call(target, input, delivery));
    },
  };
}

function callHook(instance: object, hook: LifecycleHook): unknown {
  const method: unknown = Reflect.get(instance, hook);
  if (typeof method !== 'function') {
    return undefined;
  }

  return Reflect.apply(method, instance, []);
}

export function classPieceRuntime(init: ClassPieceInit): PieceRuntime {
  const { declaration, handlers } = describePiece(init.piece);

  return {
    name: init.name,
    handlers: handlers.map((entry) => handlerOf(entry, init.instance)),
    emits: (declaration.emits ?? []).map(busContractOf),
    needs: Object.values(declaration.needs ?? {}).map((token) => token.name),
    configKeys: init.configKeys ?? Object.keys(declaration.config ?? {}),
    policy: init.policy ?? declaration.policy ?? {},
    start: [() => callHook(init.instance(), 'onStart')],
    stop: [() => callHook(init.instance(), 'onStop')],
  };
}
