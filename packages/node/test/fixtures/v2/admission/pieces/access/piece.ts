import { Handle, Piece, reject, type Rejection } from 'murmur';
import { z } from 'zod';

import {
  Authenticate,
  type Principal,
  type Rate,
  RateLimit,
  ResolveTarget,
  type Scope,
} from '../../contracts/access.ts';

export class Access extends Piece({ config: { limit: z.number().int().default(100) } }) {
  private readonly counts = new Map<string, number>();

  @Handle(Authenticate)
  async authenticate(input: Authenticate): Promise<Principal | Rejection> {
    if (input.headers['authorization'] !== 'Bearer ada') {
      return reject(401, 'missing or unknown credential');
    }

    return { userId: 'ada' };
  }

  @Handle(ResolveTarget)
  async resolve(input: ResolveTarget): Promise<Scope | Rejection> {
    const id = input.params[input.meta.param];
    if (id === 'gone') {
      return reject(404, 'the object was not found');
    }

    return { role: input.meta.role, target: `${input.meta.target}:${id}:${input.prior.userId}` };
  }

  @Handle(RateLimit)
  async limit(input: RateLimit): Promise<Rate | Rejection> {
    const bucket = input.prior.userId ?? `ip:${input.ip}`;
    const count = (this.counts.get(bucket) ?? 0) + 1;
    this.counts.set(bucket, count);

    if (count > this.config.limit) {
      return reject(429, 'too many requests', { headers: { 'retry-after': '60' } });
    }

    return { remaining: this.config.limit - count, bucket };
  }
}
