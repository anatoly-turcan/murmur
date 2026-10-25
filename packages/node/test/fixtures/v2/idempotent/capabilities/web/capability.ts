import { http, type RequestOf } from '@murmur/node/capabilities';

import { Authenticate } from '../../contracts/auth.ts';

export const served = { count: 0 };

const web = http({
  guards: [Authenticate],
  errors: {
    idempotency: {
      inProgress: { status: 409, code: 'in_progress' },
      reused: { status: 422, code: 'key_reused' },
    },
  },
  responseHeaders: () => {
    served.count += 1;

    return { 'x-served': String(served.count) };
  },
});

export default web;

export type WebRequest = RequestOf<typeof web>;
