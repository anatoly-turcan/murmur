import { createMemoryTransport } from '@murmur/transport-memory';

import { runTransportSuite } from '../../core/test/transport-suite.ts';

runTransportSuite(async () => createMemoryTransport());
