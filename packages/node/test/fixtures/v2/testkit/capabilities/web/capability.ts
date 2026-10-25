import { http, type RequestOf } from '@murmur/node/capabilities';

import { Authenticate } from '../../contracts/kit.ts';

const web = http({ guards: [Authenticate] });

export default web;

export type WebRequest = RequestOf<typeof web>;
