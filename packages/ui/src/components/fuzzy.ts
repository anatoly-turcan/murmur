export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();

  if (!q) {
    return 0;
  }

  const direct = t.indexOf(q);
  if (direct >= 0) {
    return 1000 - direct * 2 - t.length;
  }

  let score = 0;
  let at = -1;

  for (const ch of q) {
    const next = t.indexOf(ch, at + 1);
    if (next < 0) {
      return null;
    }

    score += next === at + 1 ? 5 : 1;
    at = next;
  }

  return score - t.length / 10;
}

export function fuzzyFilter<T>(items: T[], query: string, text: (item: T) => string, limit = 50): T[] {
  return items
    .flatMap((item) => {
      const score = fuzzyScore(query, text(item));

      return score === null ? [] : [{ item, score }];
    })
    .toSorted((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.item);
}
