import { http, type RequestOf } from '@murmur/node/capabilities';

const web = http({
  errors: {
    envelope: ({ code, message, issues, details }) => ({
      error: { code, message, details: details ?? issues },
    }),
    input: {
      body: { status: 422, code: 'validation_failed' },
      query: { status: 400, code: 'invalid_query' },
      headers: { status: 400, code: 'invalid_header' },
      params: { status: 404, code: 'not_found' },
      json: { status: 400, code: 'malformed_json' },
      mediaType: { status: 415, code: 'unsupported_media_type' },
      issueCodes: { too_small: 'too_short' },
    },
  },
});

export default web;

export type WebRequest = RequestOf<typeof web>;
