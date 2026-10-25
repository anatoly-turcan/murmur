import { http, type RequestOf } from '@murmur/node/capabilities';

import { Authenticate, RateLimit } from '#contracts/auth';

const web = http({
  guards: [Authenticate, RateLimit],
  errors: {
    input: { body: { status: 422, code: 'validation_failed' }, issueCodes: { too_small: 'too_short' } },
  },
  log: (auth) => ({ user: auth.userId ?? null }),
});

export default web;

export type WebRequest = RequestOf<typeof web>;
