import { defineApp } from '@murmur/node';
import { createMemoryTransport } from '@murmur/transport-memory';

export default defineApp({
  name: 'v2-pilot',
  transport: () => createMemoryTransport(),
  processes: {
    domain: { pieces: ['domain'] },
    edge: { pieces: ['edge'] },
    health: { pieces: ['health'] },
    needy: { pieces: ['needy'] },
    catchall: { pieces: ['catchall'] },
    'edge-health': { pieces: ['edge', 'health'] },
  },
});
