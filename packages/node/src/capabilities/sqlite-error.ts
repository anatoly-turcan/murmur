import { NonRetryableError } from 'murmur';

export class SqliteError extends NonRetryableError {
  override readonly name: string = 'SqliteError';

  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, { code: 'sqlite', ...options });
  }
}
