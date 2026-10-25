export interface SchemaIssue {
  readonly message: string;
  readonly path?: readonly PropertyKey[] | undefined;
}

export interface SerializedError {
  readonly name: string;
  readonly message: string;
  readonly code?: string;
  readonly retryable?: boolean;
  readonly stack?: string;
}

export interface MurmurErrorOptions {
  readonly code?: string;
  readonly retryable?: boolean;
  readonly cause?: unknown;
}

export class MurmurError extends Error {
  override readonly name: string = 'MurmurError';
  readonly code: string;
  readonly retryable: boolean;

  constructor(message: string, options: MurmurErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = options.code ?? 'murmur';
    this.retryable = options.retryable ?? true;
  }
}

export class NonRetryableError extends MurmurError {
  override readonly name: string = 'NonRetryableError';

  constructor(message: string, options: Omit<MurmurErrorOptions, 'retryable'> = {}) {
    super(message, { code: 'non-retryable', ...options, retryable: false });
  }
}

export type ViolationSide = 'payload' | 'reply' | 'config';

export class ContractViolationError extends NonRetryableError {
  override readonly name: string = 'ContractViolationError';
  readonly contract: string;
  readonly side: ViolationSide;
  readonly issues: readonly SchemaIssue[];

  constructor(contract: string, side: ViolationSide, issues: readonly SchemaIssue[]) {
    super(`${contract}: invalid ${side}: ${issues.map(describeIssue).join('; ')}`, {
      code: 'contract-violation',
    });
    this.contract = contract;
    this.side = side;
    this.issues = issues;
  }
}

export class EmitNotDeclaredError extends NonRetryableError {
  override readonly name: string = 'EmitNotDeclaredError';
  readonly piece: string;
  readonly contract: string;

  constructor(piece: string, contract: string, fix = "add it to this piece's emits") {
    super(`piece ${piece} emits ${contract} but does not declare it: ${fix}`, {
      code: 'emit-not-declared',
    });
    this.piece = piece;
    this.contract = contract;
  }
}

export class NotRequestableError extends NonRetryableError {
  override readonly name: string = 'NotRequestableError';
  readonly contract: string;

  constructor(contract: string) {
    super(`${contract} has no reply schema; use emit instead of request`, { code: 'not-requestable' });
    this.contract = contract;
  }
}

export class PieceDefinitionError extends MurmurError {
  override readonly name: string = 'PieceDefinitionError';

  constructor(message: string) {
    super(message, { code: 'piece-definition', retryable: false });
  }
}

export class LoadError extends MurmurError {
  override readonly name: string = 'LoadError';
  readonly file: string;
  readonly phase: string;

  constructor(file: string, phase: string, message: string, options: { readonly cause?: unknown } = {}) {
    super(`${file}: ${phase}: ${message}`, { code: 'load', retryable: false, ...options });
    this.file = file;
    this.phase = phase;
  }
}

function describeIssue(issue: SchemaIssue): string {
  const path = (issue.path ?? []).map(String);

  return path.length > 0 ? `${path.join('.')} ${issue.message}` : issue.message;
}

function murmurFields(error: Error): Pick<SerializedError, 'code' | 'retryable'> {
  return error instanceof MurmurError ? { code: error.code, retryable: error.retryable } : {};
}

export function serializeError(error: unknown, dev: boolean): SerializedError {
  if (!Error.isError(error)) {
    return { name: 'Error', message: String(error) };
  }

  const base = { name: error.name, message: error.message, ...murmurFields(error) };

  return dev && error.stack !== undefined ? { ...base, stack: error.stack } : base;
}

export function receivedLabel(value: unknown, importOf: string): string {
  if (value === undefined) {
    return `got undefined (check the import of the ${importOf})`;
  }

  if (typeof value === 'function') {
    return `got ${value.name || 'an anonymous function'}`;
  }

  if (typeof value === 'object' && value !== null) {
    return `got an object with keys ${Object.keys(value).join(', ') || '(none)'}`;
  }

  return `got ${String(value)}`;
}
