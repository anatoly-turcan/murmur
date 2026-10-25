import { defineApp } from '@murmur/node';
import { sqlite } from '@murmur/node/capabilities';
import { createMemoryTransport } from '@murmur/transport-memory';

export default defineApp({
  name: 'v2-app',
  transport: () => createMemoryTransport(),
  capabilities: [sqlite],
  processes: { billing: { pieces: ['billing/*'] } },
});
