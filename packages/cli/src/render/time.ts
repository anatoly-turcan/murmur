const pad = (n: number, width = 2) => String(n).padStart(width, '0');

export function instantMs(ts: string): number {
  return Number(Temporal.Instant.from(ts).epochNanoseconds / 1000n) / 1000;
}

export function clockTime(ts: string): string {
  const date = new Date(Math.floor(instantMs(ts)));

  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}
