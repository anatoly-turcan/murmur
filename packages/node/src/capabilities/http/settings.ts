import type { HttpSettings } from './binding.ts';
import { errorSettings } from './errors.ts';

export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

export const UNTOKENED_SETTINGS: HttpSettings = {
  guards: [],
  errors: errorSettings(),
  maxBodyBytes: DEFAULT_MAX_BODY_BYTES,
};

const byToken = new WeakMap<object, HttpSettings>();

export function registerSettings(token: object, settings: HttpSettings): void {
  byToken.set(token, settings);
}

function registered(token: unknown): HttpSettings | undefined {
  return token instanceof Object ? byToken.get(token) : undefined;
}

export function settingsOf(tokens: readonly unknown[]): HttpSettings | undefined {
  return tokens.map(registered).find((settings) => settings !== undefined);
}

const idempotentSettings = new WeakSet<HttpSettings>();

export function markIdempotent(settings: HttpSettings): void {
  idempotentSettings.add(settings);
}

export function hasIdempotentRoutes(settings: HttpSettings): boolean {
  return idempotentSettings.has(settings);
}
