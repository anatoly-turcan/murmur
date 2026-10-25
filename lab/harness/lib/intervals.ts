export interface Interval {
  start: number
  end: number
}

export interface Concurrency {
  max: number
  mean: number
  busy_span_s: number
}

export function maxConcurrency(intervals: Interval[]): number {
  const activeAt = (t: number, self: Interval) => intervals.filter((j) => j === self || (j.start <= t && j.end > t)).length

  return intervals.reduce((best, i) => Math.max(best, activeAt(i.start, i)), 0)
}

export function unionLength(intervals: Interval[]): number {
  const sorted = [...intervals].sort((a, b) => a.start - b.start)
  let total = 0
  let current: Interval | undefined
  for (const i of sorted) {
    if (current && i.start <= current.end) {
      current.end = Math.max(current.end, i.end)
      continue
    }
    if (current) total += current.end - current.start
    current = { ...i }
  }

  return current ? total + current.end - current.start : total
}

export function concurrency(intervals: Interval[]): Concurrency {
  const busy = unionLength(intervals)
  const work = intervals.reduce((sum, i) => sum + (i.end - i.start), 0)
  const mean = busy === 0 ? (intervals.length > 0 ? 1 : 0) : work / busy

  return { max: maxConcurrency(intervals), mean, busy_span_s: busy }
}
