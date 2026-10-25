import { describe, expect, test } from 'vitest';

import {
  formatFilter,
  matchFilter,
  parseDuration,
  parseFilter,
  withScope,
  type EventFilter,
} from '../store/filters.ts';
import type { EventRow } from '../store/rows.ts';
import { envelope } from './fixtures.ts';

function row(over: Partial<EventRow> = {}): EventRow {
  return {
    stored: { seq: 1, envelope: envelope(), meta: { internal: false } },
    from: 'billing/invoice',
    to: ['notify/send-email'],
    attempt: 1,
    durationMs: 3,
    outcome: 'acked',
    ...over,
  };
}

describe('filter mini-language', () => {
  test('parses the spec example', () => {
    expect(parseFilter('piece:billing/* contract:*.created failed: trace:7f3a internal: since:5m')).toEqual({
      piece: 'billing/*',
      contract: '*.created',
      trace: '7f3a',
      failed: true,
      internal: true,
      since: '5m',
      text: [],
    });
  });

  test.each([
    'piece:billing/* contract:*.created failed: trace:7f3a internal: since:5m',
    'contract:todo.created',
    'failed: hello world',
    'since:90s piece:todos/create',
    '',
    'unknown:thing  spaced',
    'since:soon',
  ])('round-trips %j', (input) => {
    const parsed = parseFilter(input);
    const canonical = formatFilter(parsed);
    expect(parseFilter(canonical)).toEqual(parsed);
    expect(formatFilter(parseFilter(canonical))).toBe(canonical);
  });

  test('canonical form orders keys and keeps free text last', () => {
    expect(formatFilter(parseFilter('oops since:5m failed: piece:a/*'))).toBe(
      'piece:a/* failed: since:5m oops',
    );
  });

  test('formats a filter object back into tokens', () => {
    const filter: EventFilter = { contract: 'a.b', failed: true, text: ['x'] };
    expect(formatFilter(filter)).toBe('contract:a.b failed: x');
    expect(parseFilter(formatFilter(filter))).toEqual(filter);
  });

  test('unknown keys and bad durations stay free text', () => {
    expect(parseFilter('foo:bar since:soon')).toEqual({ text: ['foo:bar', 'since:soon'] });
  });

  test('durations', () => {
    expect(parseDuration('250ms')).toBe(250);
    expect(parseDuration('5m')).toBe(300_000);
    expect(parseDuration('2h')).toBe(7_200_000);
    expect(parseDuration('1d')).toBe(86_400_000);
    expect(parseDuration('x')).toBeNull();
  });
});

describe('matching', () => {
  const now = Date.parse('2026-10-24T10:00:02.000Z');

  test('piece glob matches emitter or handler, including the group itself', () => {
    expect(matchFilter(row(), parseFilter('piece:billing/*'), now)).toBe(true);
    expect(matchFilter(row(), parseFilter('piece:notify/*'), now)).toBe(true);
    expect(matchFilter(row({ from: 'billing' }), parseFilter('piece:billing/*'), now)).toBe(true);
    expect(matchFilter(row(), parseFilter('piece:audit/*'), now)).toBe(false);
  });

  test('contract glob, trace prefix, failed, since and text', () => {
    expect(matchFilter(row(), parseFilter('contract:*.created'), now)).toBe(true);
    expect(matchFilter(row(), parseFilter('contract:todo.removed'), now)).toBe(false);
    expect(matchFilter(row(), parseFilter('trace:trace-'), now)).toBe(true);
    expect(matchFilter(row(), parseFilter('trace:zzz'), now)).toBe(false);
    expect(matchFilter(row(), parseFilter('failed:'), now)).toBe(false);
    expect(matchFilter(row({ outcome: 'deadLettered' }), parseFilter('failed:'), now)).toBe(true);
    expect(matchFilter(row(), parseFilter('since:5s'), now)).toBe(true);
    expect(matchFilter(row(), parseFilter('since:500ms'), now)).toBe(false);
    expect(matchFilter(row(), parseFilter('created'), now)).toBe(true);
  });

  test('internal events are hidden unless internal: is given', () => {
    const internal = row({
      stored: { seq: 2, envelope: envelope({ name: '$sys.delivery.acked' }), meta: { internal: true } },
    });
    expect(matchFilter(internal, parseFilter(''), now)).toBe(false);
    expect(matchFilter(internal, parseFilter('internal:'), now)).toBe(true);
  });

  test('tree scope becomes an implicit piece filter', () => {
    expect(withScope(parseFilter('failed:'), 'billing')).toEqual({
      piece: 'billing/*',
      failed: true,
      text: [],
    });
    expect(withScope(parseFilter('piece:x/*'), 'billing').piece).toBe('x/*');
    expect(withScope(parseFilter(''), null)).toEqual({ text: [] });
  });
});
