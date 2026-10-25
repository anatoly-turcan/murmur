export class SlidingWindow {
  private readonly hits = new Map<string, number[]>();
  private readonly spanMs: number;

  constructor(spanMs: number) {
    this.spanMs = spanMs;
  }

  hit(key: string, now: number, cost = 1): number {
    const recent = (this.hits.get(key) ?? []).filter((at) => now - at < this.spanMs);
    recent.push(...Array.from({ length: cost }, () => now));
    this.hits.set(key, recent);

    return recent.length;
  }
}
