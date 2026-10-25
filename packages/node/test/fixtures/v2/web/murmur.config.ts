import { defineApp } from '@murmur/node';
import { sqlite } from '@murmur/node/capabilities';
import { createMemoryTransport } from '@murmur/transport-memory';

export default defineApp({
  name: 'v2-web',
  transport: () => createMemoryTransport(),
  capabilities: [sqlite],
});
