export interface Detail {
  path: string;
  code: string;
  message?: string;
  [extra: string]: unknown;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Detail[];
  readonly headers: Record<string, string>;

  constructor(status: number, code: string, message: string, details: Detail[] = [], headers: Record<string, string> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.headers = headers;
  }
}

export const NOT_FOUND_MESSAGE = 'The requested resource was not found.';

export function notFound(): ApiError {
  return new ApiError(404, 'not_found', NOT_FOUND_MESSAGE);
}

export function gone(): ApiError {
  return new ApiError(410, 'gone', 'The resource has been deleted.');
}

export function forbidden(): ApiError {
  return new ApiError(403, 'forbidden', 'Your role does not allow this action.');
}

export function unauthenticated(): ApiError {
  return new ApiError(401, 'unauthenticated', 'A valid Authorization: Bearer header is required.');
}

export function invalidApiKey(): ApiError {
  return new ApiError(401, 'invalid_api_key', 'The API key is unknown, revoked or belongs to a deactivated user.');
}

export function methodNotAllowed(allowed: readonly string[]): ApiError {
  return new ApiError(405, 'method_not_allowed', 'This method is not supported on this path.', [], { Allow: allowed.join(', ') });
}

export function payloadTooLarge(): ApiError {
  return new ApiError(413, 'payload_too_large', 'The request body exceeds 64 KiB.');
}

export function unsupportedMediaType(): ApiError {
  return new ApiError(415, 'unsupported_media_type', 'Request bodies must be application/json.');
}

export function badRequest(code: string, message: string): ApiError {
  return new ApiError(400, code, message);
}

export function invalidQuery(message = 'A query parameter is unknown or has an invalid value.'): ApiError {
  return badRequest('invalid_query', message);
}

export function invalidHeader(message: string): ApiError {
  return badRequest('invalid_header', message);
}

export function validationFailed(details: Detail[]): ApiError {
  return new ApiError(422, 'validation_failed', 'The request body is invalid.', details.map(withMessage));
}

export function conflict(code: string, message: string, details: Detail[] = []): ApiError {
  return new ApiError(409, code, message, details.map(withMessage));
}

export function rateLimited(): ApiError {
  return new ApiError(429, 'rate_limited', 'Too many requests; retry after the current window.');
}

export function internalError(): ApiError {
  return new ApiError(500, 'internal_error', 'An unexpected error occurred.');
}

export function versionConflict(currentVersion: number): ApiError {
  return conflict('version_conflict', 'The object was modified by someone else.', [
    { path: 'version', code: 'stale', current_version: currentVersion },
  ]);
}

const DETAIL_MESSAGES: Record<string, string> = {
  required: 'This field is required.',
  invalid_type: 'This value has the wrong type.',
  too_short: 'This value is too short.',
  too_long: 'This value is too long.',
  out_of_range: 'This value is out of range.',
  invalid_enum: 'This value is not one of the allowed values.',
  invalid_format: 'This value has an invalid format.',
  invalid_timezone: 'This is not a known IANA time zone.',
  invalid_date: 'This is not a real calendar date.',
  not_nullable: 'This field cannot be null.',
  unknown_field: 'This field is not accepted.',
  duplicate: 'This value duplicates an earlier one.',
  too_many_items: 'Too many items.',
  unsupported_currency: 'This currency is not supported.',
  too_many_decimals: 'Too many decimal places for this currency.',
  user_not_found: 'No active user has this email address.',
  not_member: 'The user is not a member of this workspace.',
  not_assignable: 'The user cannot be assigned tasks in this workspace.',
  invalid_project: 'The project is not a non-deleted project of this workspace.',
  invalid_url: 'The URL must be http or https and at most 2,048 characters.',
  invalid_event: 'This is not a webhook event name.',
};

function withMessage(detail: Detail): Detail {
  return detail.message ? detail : { ...detail, message: DETAIL_MESSAGES[detail.code] ?? 'Invalid value.' };
}

export function detail(path: string, code: string, extra: Record<string, unknown> = {}): Detail {
  return { path, code, ...extra };
}

export function throwIfInvalid(details: Detail[]): void {
  if (details.length > 0) throw validationFailed(details);
}

export function errorBody(err: ApiError): { error: { code: string; message: string; details?: Detail[] } } {
  return {
    error: {
      code: err.code,
      message: err.message,
      ...(err.details.length > 0 ? { details: err.details } : {}),
    },
  };
}
