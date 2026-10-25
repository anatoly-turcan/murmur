import { kv } from '@murmur/node/capabilities';
import { bearer } from '@murmur/node/lib';
import { Handle, Piece, reject, type Rejection } from 'murmur';
import { z } from 'zod';

import { Authenticate, type Principal, type Quota, RateLimit } from '#contracts/auth';

const WINDOW_MS = 60_000;

export class Auth extends Piece({
  needs: { kv },
  config: {
    tokens: z.record(z.string(), z.string()),
    perMinute: z.number().int().positive().default(60),
  },
}) {
  @Handle(Authenticate)
  async authenticate(input: Authenticate): Promise<Principal | Rejection> {
    const token = bearer(input.headers['authorization']);
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
    const key = `rate:${input.prior.userId ?? input.ip}`;
    const { count, resetAt } = await this.kv.incr(key, { windowMs: WINDOW_MS });

    if (count > this.config.perMinute) {
      return reject(429, 'rate limit exceeded', {
        details: { perMinute: this.config.perMinute },
        headers: { 'retry-after': String(Math.ceil(resetAt.since(this.clock.now()).total('seconds'))) },
      });
    }

    return { remaining: this.config.perMinute - count };
  }
}

function rolesOf(userId: string): string[] {
  if (userId === 'root') {
    return ['admin'];
  }

  return [];
}
