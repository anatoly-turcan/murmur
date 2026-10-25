import { http, type RequestOf } from '@murmur/node/capabilities';

const web = http({
  errors: { envelope: (failure, traceId) => ({ problem: failure.code, detail: failure.message, traceId }) },
});

export default web;

export type WebRequest = RequestOf<typeof web>;
