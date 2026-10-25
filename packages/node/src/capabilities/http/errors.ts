import {
  codeForStatus,
  IDEMPOTENCY_DEFAULTS,
  NonRetryableError,
  PayloadTooLargeError,
  RemoteError,
  type Rejection,
} from 'murmur';

export interface ErrorMapping {
  readonly status: number;
  readonly code: string;
}

export interface FailureIssue {
  readonly path: readonly PropertyKey[];
  readonly code: string;
  readonly message: string;
  readonly [param: string]: unknown;
}

export interface FailureCause {
  readonly name: string;
  readonly message: string;
}

export type FailureDetails = Readonly<Record<string, unknown>> | readonly Readonly<Record<string, unknown>>[];

export interface HttpFailure {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly issues?: readonly FailureIssue[];
  readonly details?: FailureDetails;
  readonly cause?: FailureCause;
}

export type ErrorEnvelope = (failure: HttpFailure, traceId: string) => unknown;

export type InputPart = 'params' | 'query' | 'headers' | 'body' | 'json' | 'mediaType';

export type InputErrorOptions = Partial<Record<InputPart, ErrorMapping>> & {
  readonly issueCodes?: Readonly<Record<string, string>>;
};

export type IdempotencyRefusal = 'inProgress' | 'reused';

export interface ErrorOptions {
  readonly envelope?: ErrorEnvelope;
  readonly status?: Readonly<Record<string, ErrorMapping>>;
  readonly input?: InputErrorOptions;
  readonly idempotency?: Partial<Record<IdempotencyRefusal, ErrorMapping>>;
}

export interface ErrorSettings {
  readonly envelope: ErrorEnvelope;
  readonly status: Readonly<Record<string, ErrorMapping>>;
  readonly input: Readonly<Record<InputPart, ErrorMapping>>;
  readonly issueCodes: Readonly<Record<string, string>>;
  readonly idempotency: Readonly<Record<IdempotencyRefusal, ErrorMapping>>;
}

export const DEFAULT_ERROR_STATUS: Readonly<Record<string, ErrorMapping>> = {
  PayloadTooLargeError: { status: 413, code: 'payload_too_large' },
  NoRouteError: { status: 501, code: 'not_implemented' },
  RequestTimeoutError: { status: 504, code: 'timeout' },
  HandlerTimeoutError: { status: 504, code: 'timeout' },
  RemoteError: { status: 502, code: 'upstream_failed' },
};

export const DEFAULT_INPUT_ERRORS: Readonly<Record<InputPart, ErrorMapping>> = {
  params: { status: 404, code: 'not_found' },
  query: { status: 400, code: 'invalid_input' },
  headers: { status: 400, code: 'invalid_input' },
  json: { status: 400, code: 'invalid_input' },
  mediaType: { status: 415, code: 'unsupported_media_type' },
  body: { status: 400, code: 'invalid_input' },
};

const INTERNAL: ErrorMapping = { status: 500, code: 'internal' };

export class InputError extends NonRetryableError {
  override readonly name: string = 'InputError';
  readonly part: InputPart;
  readonly issues: readonly FailureIssue[];

  constructor(part: InputPart, issues: readonly FailureIssue[]) {
    super(`${part}: ${summary(issues)}`, { code: 'invalid-input' });
    this.part = part;
    this.issues = issues;
  }
}

export function defaultEnvelope(failure: HttpFailure, traceId: string): unknown {
  const { status: _status, ...error } = failure;

  return { error, traceId };
}

export function errorSettings(options: ErrorOptions = {}): ErrorSettings {
  const { issueCodes = {}, ...input } = options.input ?? {};

  return {
    envelope: options.envelope ?? defaultEnvelope,
    status: { ...DEFAULT_ERROR_STATUS, ...options.status },
    input: { ...DEFAULT_INPUT_ERRORS, ...input },
    issueCodes,
    idempotency: { ...IDEMPOTENCY_DEFAULTS.errors, ...options.idempotency },
  };
}

function summary(issues: readonly FailureIssue[]): string {
  return issues
    .map((issue) => {
      if (issue.path.length === 0) {
        return issue.message;
      }

      return `${issue.path.map(String).join('.')}: ${issue.message}`;
    })
    .join('; ');
}

function messageOf(error: unknown, mapping: ErrorMapping): string {
  if (error instanceof PayloadTooLargeError) {
    return `request body is larger than ${error.limit} bytes`;
  }

  if (error instanceof RemoteError) {
    return `${error.contract} failed`;
  }

  if (mapping === INTERNAL || !Error.isError(error)) {
    return 'internal error';
  }

  return error.message;
}

function causeOf(error: unknown): FailureCause {
  if (error instanceof RemoteError) {
    return { name: error.remoteName, message: error.message };
  }

  if (Error.isError(error)) {
    return { name: error.name, message: error.message };
  }

  return { name: 'Error', message: String(error) };
}

function mappingOf(error: unknown, settings: ErrorSettings): ErrorMapping {
  const name = Error.isError(error) ? error.name : '';

  return settings.status[name] ?? INTERNAL;
}

function renamed(issues: readonly FailureIssue[], settings: ErrorSettings): FailureIssue[] {
  return issues.map((issue) => ({ ...issue, code: settings.issueCodes[issue.code] ?? issue.code }));
}

function inputFailure(error: InputError, settings: ErrorSettings): HttpFailure {
  const { status, code } = settings.input[error.part];

  return { status, code, message: summary(error.issues), issues: renamed(error.issues, settings) };
}

export function failureOf(error: unknown, settings: ErrorSettings, mode: 'dev' | 'prod'): HttpFailure {
  if (error instanceof InputError) {
    return inputFailure(error, settings);
  }

  const mapping = mappingOf(error, settings);
  const base = { status: mapping.status, code: mapping.code, message: messageOf(error, mapping) };

  if (mapping.status >= 500 && mode === 'dev') {
    return { ...base, cause: causeOf(error) };
  }

  return base;
}

export function failureFor(status: number, message: string, details?: FailureDetails): HttpFailure {
  const failure = { status, code: codeForStatus(status), message };
  if (details === undefined) {
    return failure;
  }

  return { ...failure, details };
}

export function rejectionFailure(rejection: Rejection): HttpFailure {
  const { status, code, message, details } = rejection;

  return details === undefined ? { status, code, message } : { status, code, message, details };
}

export function renderFailure(failure: HttpFailure, settings: ErrorSettings, traceId: string): Response {
  return Response.json(settings.envelope(failure, traceId), { status: failure.status });
}
