import { defineApp } from '@murmur/node';
import { createMemoryTransport } from '@murmur/transport-memory';

export default defineApp({
  name: 'v2-processes',
  transport: () => createMemoryTransport(),
  processes: {
    api: { pieces: ['edge', 'admin'] },
    worker: { pieces: ['worker'] },
    quiet: { pieces: ['edge', 'worker'], jobs: false },
  },
});
