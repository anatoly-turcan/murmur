import { Handle, Piece, reject, type Rejection } from 'murmur';

import { Authenticate, type Principal } from '../../contracts/kit.ts';

export class Auth extends Piece() {
  @Handle(Authenticate)
  async authenticate(input: Authenticate): Promise<Principal | Rejection> {
    if (input.headers['authorization'] !== 'Bearer ada') {
      return reject(401, 'missing or unknown credential');
    }

    return { userId: 'ada' };
  }
}
