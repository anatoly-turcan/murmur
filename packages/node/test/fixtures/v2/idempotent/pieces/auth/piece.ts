import { bearer } from '@murmur/node/lib';
import { Handle, Piece, reject, type Rejection } from 'murmur';

import { Authenticate, type Principal } from '../../contracts/auth.ts';

export class Auth extends Piece() {
  @Handle(Authenticate)
  async authenticate(input: Authenticate): Promise<Principal | Rejection> {
    const token = bearer(input.headers['authorization']);
    if (token === null) {
      return reject(401, 'missing bearer token');
    }

    return { userId: token };
  }
}
