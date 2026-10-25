import { WEBHOOK_EVENTS } from '../../domain/events.ts';
import { ORG_EVENT_TYPES } from '../../domain/org-events.ts';
import { detail, type Detail } from '../../http/errors.ts';
import { bool, custom, INVALID, type Field, type FieldSpecs } from '../../http/validate.ts';
import { codePoints, nfcTrim } from '../../text/normalize.ts';

const URL_MAX = 2048;
const SECRET_RE = /^[\x20-\x7e]*$/;

function fail(details: Detail[], path: string, code: string): typeof INVALID {
  details.push(detail(path, code));

  return INVALID;
}

function isHttpUrl(text: string): boolean {
  if (!URL.canParse(text)) return false;
  const url = new URL(text);

  return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== '';
}

export const webhookUrl: Field<string> = custom((value, path, details) => {
  if (typeof value !== 'string') return fail(details, path, 'invalid_type');
  const text = nfcTrim(value);

  return codePoints(text) <= URL_MAX && isHttpUrl(text) ? text : fail(details, path, 'invalid_url');
});

function eventProblem(allowed: readonly string[], value: unknown, index: number, all: unknown[]): string | null {
  if (value === '*') return all.length === 1 ? null : 'invalid_event';
  if (typeof value !== 'string' || !allowed.includes(value)) return 'invalid_event';

  return all.indexOf(value) < index ? 'duplicate' : null;
}

function eventsField(allowed: readonly string[]): Field<string[]> {
  return custom((value, path, details) => {
    if (!Array.isArray(value)) return fail(details, path, 'invalid_type');
    if (value.length === 0) return fail(details, path, 'too_short');
    const before = details.length;
    value.forEach((event, i) => {
      const problem = eventProblem(allowed, event, i, value);
      if (problem) details.push(detail(`${path}[${i}]`, problem));
    });

    return details.length > before ? INVALID : (value as string[]);
  });
}

export const webhookEvents = eventsField(WEBHOOK_EVENTS);

export const webhookSecret: Field<string> = custom((value, path, details) => {
  if (typeof value !== 'string') return fail(details, path, 'invalid_type');
  const text = nfcTrim(value);
  if (!SECRET_RE.test(text)) return fail(details, path, 'invalid_format');
  if (text.length < 32) return fail(details, path, 'too_short');

  return text.length <= 256 ? text : fail(details, path, 'too_long');
});

export const WEBHOOK_CREATE_FIELDS = { url: webhookUrl, events: webhookEvents, secret: webhookSecret } satisfies FieldSpecs;

export const WEBHOOK_PATCH_FIELDS = { url: webhookUrl, events: webhookEvents, active: bool() } satisfies FieldSpecs;

const orgWebhookEvents = eventsField(ORG_EVENT_TYPES);

export const ORG_WEBHOOK_CREATE_FIELDS = { url: webhookUrl, events: orgWebhookEvents, secret: webhookSecret } satisfies FieldSpecs;

export const ORG_WEBHOOK_PATCH_FIELDS = { url: webhookUrl, events: orgWebhookEvents, active: bool() } satisfies FieldSpecs;
