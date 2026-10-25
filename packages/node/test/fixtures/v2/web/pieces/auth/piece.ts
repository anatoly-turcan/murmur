import { Handle, Piece, reject, type Rejection } from 'murmur';
import { z } from 'zod';

import { Authenticate, type Principal, type Quota, RateLimit } from '../../contracts/auth.ts';
import { SlidingWindow } from './window.ts';

export class Auth extends Piece({
  config: {
    tokens: z.record(z.string(), z.string()),
    perMinute: z.number().int().positive().default(60),
  },
}) {
  private readonly window = new SlidingWindow(60_000);

  @Handle(Authenticate)
  async authenticate(input: Authenticate): Promise<Principal | Rejection> {
    const token = bearerOf(input.headers['authorization']);
    if (token === null) {
      return reject(401, 'missing bearer token');
    }

    const userId = this.config.tokens[token];
    if (userId === undefined) {
      return reject(401, 'unknown token');
    }

    return { userId, roles: rolesOf(userId) };
  }

  @Handle(RateLimit)
  async limit(input: RateLimit): Promise<Quota | Rejection> {
    const key = input.headers['authorization'] ?? input.headers['x-forwarded-for'] ?? 'anonymous';
    const used = this.window.hit(key, this.clock.now().epochMilliseconds);

    if (used > this.config.perMinute) {
      return reject(429, 'rate limit exceeded', { details: { perMinute: this.config.perMinute } });
    }

    return { remaining: this.config.perMinute - used };
  }
}

function bearerOf(header: string | undefined): string | null {
  if (header === undefined || !header.startsWith('Bearer ')) {
    return null;
  }

  return header.slice('Bearer '.length);
}

function rolesOf(userId: string): string[] {
  if (userId === 'root') {
    return ['admin'];
  }

  return [];
}
