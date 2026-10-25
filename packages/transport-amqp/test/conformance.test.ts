import { test } from 'node:test';

import { createAmqpTransport } from '@murmur/transport-amqp';

import { runTransportSuite } from '../../core/test/transport-suite.ts';
import { AMQP_URL, skip } from './helpers.ts';

const url = AMQP_URL;
if (url === undefined) {
  test('amqp transport conformance', { skip }, () => undefined);
} else {
  runTransportSuite(() => createAmqpTransport({ url }));
}
