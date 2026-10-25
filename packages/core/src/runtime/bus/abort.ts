export function raceAbort(
  work: Promise<unknown>,
  signal: AbortSignal,
  onAbandon: () => void = () => {},
): Promise<unknown> {
  if (signal.aborted) {
    onAbandon();

    return Promise.reject(signal.reason);
  }

  const { promise, resolve, reject } = Promise.withResolvers<unknown>();
  const onAbort = () => {
    onAbandon();
    reject(signal.reason);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  void work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));

  return promise;
}

export function onAnyAbort(
  signals: readonly (AbortSignal | undefined)[],
  onAbort: (reason: unknown) => void,
): () => void {
  const live = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (live.length === 0) {
    return () => {};
  }

  const merged = AbortSignal.any(live);
  const listener = () => onAbort(merged.reason);
  merged.addEventListener('abort', listener, { once: true });

  return () => merged.removeEventListener('abort', listener);
}
