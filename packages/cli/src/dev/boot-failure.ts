import type { BootReport } from '@murmur/dev-protocol';

const PORT_IN_USE = /EADDRINUSE on port (\d+)(?: \((\S+)\))?/;

function field(error: unknown, key: string): unknown {
  return error instanceof Error ? Reflect.get(error, key) : undefined;
}

export function isSystemError(error: unknown): boolean {
  return typeof field(error, 'syscall') === 'string';
}

function startFailureMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const code = field(error, 'code');
  const port = field(error, 'port');

  if (code === 'EADDRINUSE' && typeof port === 'number') {
    const capability = field(error, 'capability');
    const owner = typeof capability === 'string' ? ` (${capability})` : '';

    return `EADDRINUSE on port ${port}${owner}: ${String(field(error, 'address') ?? 'the address')}:${port} is already in use`;
  }

  return typeof code === 'string' && !error.message.includes(code)
    ? `${code}: ${error.message}`
    : `${error.name}: ${error.message}`;
}

export class StartFailedError extends Error {
  override readonly name = 'StartFailedError';
  readonly report: BootReport;

  constructor(cause: unknown) {
    super(startFailureMessage(cause), { cause });
    this.report = {
      ok: false,
      pieces: [],
      errors: [{ phase: 'start', message: this.message }],
      warnings: [],
      catalog: { contracts: [], capabilities: [] },
    };
  }
}

export function portHint(report: BootReport): string | null {
  const taken = report.errors.map((e) => PORT_IN_USE.exec(e.message)).find((m) => m !== null);
  if (taken === undefined) {
    return null;
  }

  const [, port, capability] = taken;
  const envVar = `MURMUR__CAP_${envPrefixOf(capability ?? 'http')}__PORT`;

  return `hint: port ${port} is taken; set ${envVar}=<free port> in .env (or the shell) and murmur dev restarts`;
}

function envPrefixOf(name: string): string {
  return name.toUpperCase().replaceAll('/', '_').replaceAll('-', '_');
}
