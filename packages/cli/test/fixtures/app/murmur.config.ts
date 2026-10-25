import { defineApp } from '@murmur/node';
import { sqlite } from '@murmur/node/capabilities';
import { createMemoryTransport } from '@murmur/transport-memory';

export default defineApp({
  name: 'cli-fixture',
  transport: () => createMemoryTransport(),
  capabilities: [sqlite],
});
