export interface Spread {
  n: number
  mean: number
  min: number
  max: number
  sd: number
}

export function spread(values: number[]): Spread | undefined {
  if (values.length === 0) return undefined
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length
  const variance = values.length > 1 ? values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1) : 0

  return { n: values.length, mean, min: Math.min(...values), max: Math.max(...values), sd: Math.sqrt(variance) }
}

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)

  return sorted.length % 2 === 1 ? (sorted[mid] ?? NaN) : ((sorted[mid - 1] ?? NaN) + (sorted[mid] ?? NaN)) / 2
}

export function ratio(part: number, whole: number): number {
  return whole === 0 ? 0 : part / whole
}

export function formatNumber(value: number): string {
  if (Number.isInteger(value) && Math.abs(value) >= 1000) return value.toLocaleString('en-US')
  if (Math.abs(value) < 1 && value !== 0) return value.toFixed(3)

  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

export function formatSpread(s: Spread | undefined): string {
  if (!s) return '—'
  if (s.n === 1) return `${formatNumber(s.mean)} (n=1)`

  return `${formatNumber(s.mean)} (${formatNumber(s.min)}–${formatNumber(s.max)}, n=${s.n})`
}
