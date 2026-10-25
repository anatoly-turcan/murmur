import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { BootReport } from '@murmur/dev-protocol';

import { portHint } from '../src/dev/boot-failure.ts';

function reportWith(message: string): BootReport {
  return {
    ok: false,
    pieces: [],
    errors: [{ phase: 'start', message }],
    warnings: [],
    catalog: { contracts: [], capabilities: [] },
  };
}

test('the port hint names the env var of the capability that failed to listen', () => {
  const hint = portHint(reportWith('EADDRINUSE on port 3000 (web): 127.0.0.1:3000 is already in use'));

  assert.equal(
    hint,
    'hint: port 3000 is taken; set MURMUR__CAP_WEB__PORT=<free port> in .env (or the shell) and murmur dev restarts',
  );
});

test('the port hint falls back to http when the error names no capability', () => {
  const hint = portHint(reportWith('EADDRINUSE on port 3000: 127.0.0.1:3000 is already in use'));

  assert.match(hint ?? '', /MURMUR__CAP_HTTP__PORT/);
});

test('no port hint for other start failures', () => {
  assert.equal(portHint(reportWith('SqliteError: unable to open database file')), null);
});
