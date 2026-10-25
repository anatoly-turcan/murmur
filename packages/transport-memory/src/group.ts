import { matchPattern, type DeliveryHandler, type SubscribeOptions } from 'murmur';

export interface Item {
  readonly bytes: string;
  readonly attempt: number;
  readonly redelivered: boolean;
  readonly notBefore: number;
  readonly expiresAt: number;
}

export interface InFlight {
  readonly done: Promise<void>;
  requeue(): void;
}

export interface Group {
  readonly name: string;
  readonly queue: Item[];
  readonly inflight: Set<InFlight>;
  patterns: readonly string[];
  handler: DeliveryHandler | undefined;
  owner: object | undefined;
  prefetch: number;
  exclusive: boolean;
  maxLength: number;
  ttlMs: number;
  wakeAt: number;
  cancelWake: (() => void) | undefined;
}

export function createGroup(name: string): Group {
  return {
    name,
    queue: [],
    inflight: new Set(),
    patterns: [],
    handler: undefined,
    owner: undefined,
    prefetch: 1,
    exclusive: false,
    maxLength: Infinity,
    ttlMs: Infinity,
    wakeAt: Infinity,
    cancelWake: undefined,
  };
}

export function attach(
  group: Group,
  patterns: readonly string[],
  handler: DeliveryHandler,
  options: SubscribeOptions,
): object {
  const owner = {};
  group.patterns = [...patterns];
  group.handler = handler;
  group.owner = owner;
  group.prefetch = Math.max(1, options.prefetch);
  group.exclusive = options.exclusive ?? false;
  group.maxLength = options.retention?.maxLength ?? Infinity;
  group.ttlMs = options.retention?.ttlMs ?? Infinity;

  return owner;
}

export function detach(group: Group): void {
  group.handler = undefined;
  group.owner = undefined;
  stopWake(group);
}

export function matches(group: Group, name: string): boolean {
  return group.patterns.some((pattern) => matchPattern(pattern, name));
}

export function enqueue(group: Group, item: Item): void {
  group.queue.push(item);

  while (group.queue.length > group.maxLength) {
    group.queue.shift();
  }
}

function dropExpired(group: Group, now: number): void {
  for (let i = group.queue.length - 1; i >= 0; i--) {
    if ((group.queue[i]?.expiresAt ?? Infinity) <= now) {
      group.queue.splice(i, 1);
    }
  }
}

export function takeReady(group: Group, now: number): Item | undefined {
  dropExpired(group, now);
  const index = group.queue.findIndex((item) => item.notBefore <= now);

  return index < 0 ? undefined : group.queue.splice(index, 1)[0];
}

export function nextDue(group: Group): number | undefined {
  let due: number | undefined;
  for (const item of group.queue) {
    due = Math.min(due ?? Infinity, item.notBefore);
  }

  return due;
}

export function stopWake(group: Group): void {
  group.cancelWake?.();
  group.cancelWake = undefined;
  group.wakeAt = Infinity;
}

export function wakeAt(group: Group, at: number, now: number, wake: () => void): void {
  if (group.cancelWake !== undefined && group.wakeAt <= at) {
    return;
  }

  stopWake(group);
  group.wakeAt = at;
  const run = () => {
    group.cancelWake = undefined;
    group.wakeAt = Infinity;
    wake();
  };

  if (at <= now) {
    const handle = setImmediate(run);
    group.cancelWake = () => clearImmediate(handle);
  } else {
    const handle = setTimeout(run, Math.ceil(at - now));
    group.cancelWake = () => clearTimeout(handle);
  }
}

export function isSettled(group: Group): boolean {
  return group.inflight.size === 0 && (group.handler === undefined || group.queue.length === 0);
}
