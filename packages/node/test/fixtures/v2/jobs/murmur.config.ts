import { defineApp } from '@murmur/node';
import { createMemoryTransport } from '@murmur/transport-memory';

export default defineApp({
  name: 'v2-jobs',
  transport: () => createMemoryTransport(),
  processes: {
    main: { pieces: ['producer', 'worker'] },
    producer: { pieces: ['producer'] },
    worker: { pieces: ['worker'] },
    plain: { pieces: ['plain'] },
    ticker: { pieces: ['ticker'] },
    timed: { pieces: ['worker', 'ticker'] },
  },
});
