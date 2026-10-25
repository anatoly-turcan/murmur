import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as murmur from 'murmur';

const { MurmurError, NonRetryableError, serializeError } = murmur;

const expected: Record<string, { parent: string; retryable: boolean }> = {
  NonRetryableError: { parent: 'MurmurError', retryable: false },
  ContractViolationError: { parent: 'NonRetryableError', retryable: false },
  EmitNotDeclaredError: { parent: 'NonRetryableError', retryable: false },
  NotRequestableError: { parent: 'NonRetryableError', retryable: false },
  CascadeDepthError: { parent: 'NonRetryableError', retryable: false },
  NoHandlerError: { parent: 'NonRetryableError', retryable: false },
  PayloadTooLargeError: { parent: 'NonRetryableError', retryable: false },
  EnvelopeShapeError: { parent: 'NonRetryableError', retryable: false },
  NoRouteError: { parent: 'MurmurError', retryable: false },
  RequestTimeoutError: { parent: 'MurmurError', retryable: false },
  RemoteError: { parent: 'MurmurError', retryable: false },
  HandlerTimeoutError: { parent: 'MurmurError', retryable: true },
  ShutdownError: { parent: 'MurmurError', retryable: true },
  PieceDefinitionError: { parent: 'MurmurError', retryable: false },
  DuplicateResponderError: { parent: 'MurmurError', retryable: false },
  LoadError: { parent: 'MurmurError', retryable: false },
  TransportError: { parent: 'MurmurError', retryable: true },
};

function errorClass(name: string): abstract new (...args: never[]) => Error {
  const value: unknown = Reflect.get(murmur, name);
  assert.equal(typeof value, 'function', `${name} is exported`);

  return value as abstract new (...args: never[]) => Error;
}

test('every §3.10 error class is exported, named, and sits in one hierarchy', () => {
  for (const [name, { parent }] of Object.entries(expected)) {
    const cls = errorClass(name);
    assert.equal(cls.name, name);
    assert.equal(Object.getPrototypeOf(cls), errorClass(parent), `${name} extends ${parent}`);
    assert.ok(cls.prototype instanceof MurmurError);
  }
});

test('retryable flags follow the classification table', () => {
  const samples: Error[] = [
    new murmur.ContractViolationError('a.b', 'payload', [{ message: 'bad' }]),
    new murmur.EmitNotDeclaredError('billing/invoice', 'audit.logged'),
    new murmur.NotRequestableError('audit.logged'),
    new murmur.CascadeDepthError('a.b', 33, 32),
    new murmur.NoHandlerError('billing/invoice', 'a.b'),
    new murmur.PayloadTooLargeError('a.b', 2_000_000, 1_048_576),
    new murmur.EnvelopeShapeError('unknown key "x"'),
    new murmur.NoRouteError('a.b'),
    new murmur.RequestTimeoutError('a.b', 'c0f1e2d3-4a5b-4c6d-8e9f-0a1b2c3d4e5f', 10_000),
    new murmur.RemoteError('a.b', { name: 'Error', message: 'boom' }),
    new murmur.HandlerTimeoutError('billing/invoice', 'a.b', 30_000),
    new murmur.ShutdownError('stopping'),
    new murmur.PieceDefinitionError('.config() declared twice'),
    new murmur.DuplicateResponderError('a.b', ['x', 'y']),
    new murmur.LoadError('pieces/x/piece.ts', 'import', 'boom'),
    new murmur.TransportError('confirm failed'),
  ];

  for (const error of samples) {
    assert.ok(error instanceof MurmurError);
    assert.equal(error.retryable, expected[error.name]?.retryable, error.name);
    assert.match(error.code, /^[a-z]+(-[a-z]+)*$/, error.name);
  }

  assert.equal(new NonRetryableError('x').retryable, false);
  assert.equal(new MurmurError('x').retryable, true);
  assert.equal(new murmur.TransportError('group subscribed twice', { retryable: false }).retryable, false);
});

test('RemoteError carries code and retryable from the wire', () => {
  const error = new murmur.RemoteError('billing.tax.lookup', {
    name: 'HandlerTimeoutError',
    message: 'slow',
    code: 'handler-timeout',
    retryable: true,
  });
  assert.equal(error.message, 'slow');
  assert.equal(error.code, 'handler-timeout');
  assert.equal(error.retryable, true);
  assert.equal(error.remoteName, 'HandlerTimeoutError');
});

test('serializeError keeps name, message, code and retryable; stack only in dev', () => {
  const error = new murmur.EmitNotDeclaredError('billing/invoice', 'audit.logged');
  const prod = serializeError(error, false);
  assert.deepEqual(prod, {
    name: 'EmitNotDeclaredError',
    message: error.message,
    code: 'emit-not-declared',
    retryable: false,
  });
  assert.match(serializeError(error, true).stack ?? '', /EmitNotDeclaredError/);
  assert.deepEqual(serializeError(new TypeError('x'), false), { name: 'TypeError', message: 'x' });
  assert.deepEqual(serializeError('plain', true), { name: 'Error', message: 'plain' });
});
