import type { Limits } from './types.ts';

export const DEFAULT_LIMITS: Limits = {
  ctxLargeTokens: 25_000,
  ctxWarnTokens: 40_000,
  ctxFailTokens: 80_000,
  pieceLines: 1_500,
  handlers: 20,
  contextLines: 120,
};

export function resolveLimits(given: unknown): Limits {
  if (typeof given !== 'object' || given === null) {
    return DEFAULT_LIMITS;
  }

  const pick = (key: keyof Limits): number => {
    const value: unknown = Reflect.get(given, key);

    return typeof value === 'number' ? value : DEFAULT_LIMITS[key];
  };

  return {
    ctxLargeTokens: pick('ctxLargeTokens'),
    ctxWarnTokens: pick('ctxWarnTokens'),
    ctxFailTokens: pick('ctxFailTokens'),
    pieceLines: pick('pieceLines'),
    handlers: pick('handlers'),
    contextLines: pick('contextLines'),
  };
}
