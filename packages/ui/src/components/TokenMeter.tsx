import type { ReactNode } from 'react';
export interface TokenMeterProps {
  tokens: number;
  warnAt: number;
  failAt: number;
}

export function meterTone(tokens: number, warnAt: number, failAt: number): 'ok' | 'warn' | 'fail' {
  if (tokens >= failAt) {
    return 'fail';
  }

  if (tokens >= warnAt) {
    return 'warn';
  }

  return 'ok';
}

const FILL = { ok: 'bg-ok', warn: 'bg-warn', fail: 'bg-fail' };

export function TokenMeter({ tokens, warnAt, failAt }: TokenMeterProps): ReactNode {
  const scale = failAt * 1.25;
  const pct = (v: number) => `${Math.min(100, (v / scale) * 100)}%`;

  return (
    <div className="relative h-2 w-full rounded bg-panel" title={`${tokens} tokens`}>
      <div
        className={`h-2 rounded ${FILL[meterTone(tokens, warnAt, failAt)]}`}
        style={{ width: pct(tokens) }}
      />
      <div
        className="absolute top-[-2px] h-3 w-px bg-warn"
        style={{ left: pct(warnAt) }}
        title={`warn ${warnAt}`}
      />
      <div
        className="absolute top-[-2px] h-3 w-px bg-fail"
        style={{ left: pct(failAt) }}
        title={`fail ${failAt}`}
      />
    </div>
  );
}
