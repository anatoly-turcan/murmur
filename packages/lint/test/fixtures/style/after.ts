interface Store {
  load(id: string): Promise<number | undefined>;
  save(id: string, value: number): Promise<void>;
  log(message: string): void;
}

export function clamp(value: number, max: number): number {
  if (value > max) {
    return max;
  }

  const floor = 0;
  if (value < floor) {
    return floor;
  }

  return value;
}

export async function bump(store: Store, id: string): Promise<number> {
  const current = await store.load(id);
  if (current === undefined) {
    return 0;
  }

  const next = current + 1;
  const doubled = next * 2;

  if (doubled > 100) {
    store.log('large');
  }

  await store.save(id, next);
  await store.log(`saved ${id}`);
  const confirmed = await store.load(id);

  return confirmed ?? next;
}

export async function report(store: Store, ids: readonly string[]): Promise<string> {
  const values = await Promise.all(ids.map((id) => store.load(id)));
  const lines: string[] = [];

  for (const [index, value] of values.entries()) {
    if (value !== undefined) {
      lines.push(`${ids[index]}=${value}`);
    }
  }

  await store.save('report', lines.length);

  await store.log(
    `report of ${lines.length} values written for the ids ${ids.join(', ')} at the end of the day`,
  );

  return lines.join('\n');
}
