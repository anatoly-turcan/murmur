export type Severity = 'error' | 'warn';

export interface Finding {
  readonly rule: string;
  readonly severity: Severity;
  readonly file: string;
  readonly line: number;
  readonly col: number;
  readonly message: string;
  readonly help?: string;
  readonly pieces?: readonly string[];
}

export function finding(
  rule: string,
  severity: Severity,
  file: string,
  message: string,
  extra: { line?: number; col?: number; help?: string; pieces?: readonly string[] } = {},
): Finding {
  return {
    rule,
    severity,
    file,
    line: extra.line ?? 1,
    col: extra.col ?? 1,
    message,
    ...(extra.help === undefined ? {} : { help: extra.help }),
    ...(extra.pieces === undefined || extra.pieces.length === 0 ? {} : { pieces: extra.pieces }),
  };
}
