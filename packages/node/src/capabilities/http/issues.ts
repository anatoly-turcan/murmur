import type { ZodIssue } from './coerce.ts';
import { InputError, type FailureIssue, type InputPart } from './errors.ts';

const ZOD_PREFIX = 'Invalid input: ';

function plainMessage(message: string): string {
  return message.startsWith(ZOD_PREFIX) ? message.slice(ZOD_PREFIX.length) : message;
}

export function failureIssue(issue: ZodIssue): FailureIssue {
  const {
    path,
    code,
    message,
    input: _input,
    params,
    ...rest
  } = issue as ZodIssue & {
    readonly input?: unknown;
    readonly params?: Readonly<Record<string, unknown>>;
  };

  return { path: [...path], code, message: plainMessage(message), ...rest, ...params };
}

export function inputError(part: InputPart, issues: readonly ZodIssue[]): InputError {
  return new InputError(part, issues.map(failureIssue));
}

export function rootError(part: InputPart, code: string, message: string): InputError {
  return new InputError(part, [{ path: [], code, message }]);
}
