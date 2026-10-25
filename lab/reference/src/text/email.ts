import { codePoints, fold } from './normalize.ts';

export const EMAIL_MAX = 254;

export type EmailProblem = 'too_long' | 'invalid_format';

export function emailProblem(email: string): EmailProblem | null {
  if (codePoints(email) > EMAIL_MAX) return 'too_long';
  const parts = email.split('@');
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') return 'invalid_format';

  return null;
}

export function emailKey(email: string): string {
  return fold(email);
}
