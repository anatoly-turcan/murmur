import { defineApp } from '@murmur/node';
import { createMemoryTransport } from '@murmur/transport-memory';

export default defineApp({ name: 'v2-overlap', transport: () => createMemoryTransport() });
