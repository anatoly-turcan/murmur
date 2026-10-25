import type { GuardClass } from 'murmur';

import { httpToken, type HttpToken, type HttpTokenOptions } from './token.ts';

export type {
  AuthOf,
  HttpBinding,
  HttpMethod,
  HttpRawBinding,
  HttpRoute,
  IdempotentOptions,
  PathParams,
  RouteOptions,
} from './binding.ts';
export type {
  ErrorEnvelope,
  ErrorMapping,
  ErrorOptions,
  FailureDetails,
  FailureIssue,
  HttpFailure,
  InputErrorOptions,
  InputPart,
} from './errors.ts';
export type { PartSpec } from './input.ts';
export type { ReadResult, ReadSpec } from './read.ts';
export type { HttpRequest, HttpResult } from './request.ts';
export type { ReplyBody, ReplyOptions } from './respond.ts';
export type { HttpServer } from './server.ts';
export type { HttpMakers, HttpToken, HttpTokenOptions, RequestOf } from './token.ts';

export function http<const G extends readonly GuardClass[] = []>(
  options: HttpTokenOptions<G> = {},
): HttpToken<G> {
  return httpToken(options);
}
