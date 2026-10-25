import type { z } from 'zod';

import type { Clock, Ids, Log } from './capabilities.ts';
import type { EnterInit } from './context.ts';
import type { ContractClass, EventClass, InputOf, OutputOf, RequestClass } from './contract-class.ts';
import type { IngressPort } from './ingress.ts';
import type { RequestOptions } from './policy.ts';
import type { Schema } from './schema.ts';

export interface CapabilityBus {
  readonly stopping: AbortSignal;
  emit<C extends EventClass>(contract: C, payload: InputOf<C>): Promise<void>;
  request<C extends RequestClass>(
    contract: C,
    input: InputOf<C>,
    options?: RequestOptions,
  ): Promise<OutputOf<C>>;
  enter<R>(init: EnterInit, fn: () => R): R;
}

export type ConfigOutput<Cfg extends Schema | undefined> = Cfg extends Schema ? z.output<Cfg> : undefined;

export interface CapabilityStart<Cfg extends Schema | undefined> {
  readonly config: ConfigOutput<Cfg>;
  readonly needs: Record<string, unknown>;
  readonly bus: CapabilityBus;
  readonly log: Log;
  readonly clock: Clock;
  readonly ids: Ids;
  readonly mode: 'dev' | 'prod';
  readonly signal: AbortSignal;
  readonly root: string;
  readonly ingress?: IngressPort;
}

export interface CapabilityFake {
  readonly root: string;
  readonly pieceDir: string | undefined;
  readonly clock: Clock;
  readonly needs: Readonly<Record<string, unknown>>;
}

export interface CapabilityDefinition<
  N extends string = string,
  Cfg extends Schema | undefined = Schema | undefined,
  H = unknown,
> {
  readonly name: N;
  readonly config?: Cfg;
  readonly needs?: readonly string[];
  readonly ingress?: boolean;
  readonly emits?: readonly ContractClass[];
  readonly requests?: readonly ContractClass[];
  readonly docs?: string;
  start(ctx: CapabilityStart<Cfg>): H | Promise<H>;
  stop?(instance: H, signal: AbortSignal): void | Promise<void>;
  fake?(ctx: CapabilityFake): H | Promise<H>;
}

export interface Capability<Name extends string = string, Handle = unknown> {
  readonly name: Name;
  start(ctx: never): unknown;
  readonly '~handle'?: Handle;
}

export type HandleOf<T> = T extends Capability<string, infer Handle> ? Handle : never;

export type AnyCapabilityDefinition = CapabilityDefinition<string, Schema | undefined, unknown>;

export function defineCapability<
  const N extends string,
  Cfg extends Schema | undefined = undefined,
  H = unknown,
>(def: CapabilityDefinition<N, Cfg, H>): CapabilityDefinition<N, Cfg, H> & Capability<N, H> {
  return def;
}

export function isCapabilityToken(value: unknown): value is Capability {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof Reflect.get(value, 'name') === 'string' &&
    typeof Reflect.get(value, 'start') === 'function'
  );
}
