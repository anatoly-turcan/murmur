export const EXIT = {
  ok: 0,
  findings: 1,
  usage: 2,
  noDevServer: 3,
  boot: 4,
  internal: 5,
  interrupted: 130,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export class CliError extends Error {
  override readonly name = 'CliError';
  readonly code: ExitCode;
  readonly hint: string | undefined;

  constructor(code: ExitCode, message: string, hint?: string) {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}

export function usageError(message: string, hint?: string): CliError {
  return new CliError(EXIT.usage, message, hint);
}
