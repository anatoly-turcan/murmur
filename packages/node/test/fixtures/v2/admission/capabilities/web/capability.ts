import { http, type RequestOf } from '@murmur/node/capabilities';

import { Authenticate, RateLimit, ResolveTarget } from '../../contracts/access.ts';

const web = http({
  guards: [Authenticate, ResolveTarget, RateLimit],
  maxBodyBytes: 16,
  responseHeaders: (auth) => ({ 'x-rate-remaining': String(auth.remaining ?? 'none') }),
  log: (auth) => ({ user: auth.userId ?? null }),
});

export default web;

export type WebRequest = RequestOf<typeof web>;
