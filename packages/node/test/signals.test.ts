import assert from 'node:assert/strict';
import { test } from 'node:test';

import { installSignals } from '../src/signals.ts';

test('SIGTERM calls stop once with the signal name and uninstall removes the handlers', () => {
  const reasons: string[] = [];
  const before = process.listenerCount('SIGTERM');
  const beforeInt = process.listenerCount('SIGINT');
  const uninstall = installSignals((reason) => {
    reasons.push(reason);
  });
  assert.equal(process.listenerCount('SIGTERM'), before + 1);
  process.emit('SIGTERM');
  assert.deepEqual(reasons, ['SIGTERM']);
  uninstall();
  assert.equal(process.listenerCount('SIGTERM'), before);
  assert.equal(process.listenerCount('SIGINT'), beforeInt);
});
