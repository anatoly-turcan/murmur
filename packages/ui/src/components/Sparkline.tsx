import type { ReactNode } from 'react';
export function sparkPath(values: number[], width: number, height: number): string {
  const max = Math.max(1, ...values);
  const step = values.length > 1 ? width / (values.length - 1) : width;

  return values
    .map(
      (v, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${(height - (v / max) * height).toFixed(1)}`,
    )
    .join(' ');
}

export function Sparkline({
  values,
  width = 80,
  height = 16,
}: {
  values: number[];
  width?: number;
  height?: number;
}): ReactNode {
  return (
    <svg width={width} height={height} className="text-accent" aria-hidden>
      <path d={sparkPath(values, width, height)} fill="none" stroke="currentColor" strokeWidth={1} />
    </svg>
  );
}
