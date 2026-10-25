export function inSequence<T, R>(items: readonly T[], step: (item: T) => Promise<R>): Promise<R[]> {
  return items.reduce<Promise<R[]>>(async (previous, item) => {
    const done = await previous;

    return [...done, await step(item)];
  }, Promise.resolve([]));
}
