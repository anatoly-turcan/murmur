import { http, type RequestOf } from '@murmur/node/capabilities';

import { Authenticate, RateLimit } from '../../contracts/auth.ts';

const web = http({ guards: [Authenticate, RateLimit] });

export default web;

export type WebRequest = RequestOf<typeof web>;
