import { Handle, Piece, reject, type Rejection } from 'murmur';

import { type AdminGrant, RequireAdmin } from '../../contracts/grants.ts';

export class Grants extends Piece() {
  @Handle(RequireAdmin)
  async admin(input: RequireAdmin): Promise<AdminGrant | Rejection> {
    if (input.headers['x-explode'] !== undefined) {
      throw new Error('grant store unavailable');
    }

    if (input.headers['authorization'] !== 'Bearer root') {
      return reject(403, 'admin only');
    }

    return { admin: true };
  }
}
