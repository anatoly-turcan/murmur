import { setTimeout as sleep } from 'node:timers/promises';

import { jobs, sqlite } from '@murmur/node/capabilities';
import { type Delivery, Handle, NonRetryableError, Piece } from 'murmur';

import { Again, Fatal, Flaky, Record, Slow } from '../../contracts/jobs.ts';

export class Worker extends Piece({ needs: { db: sqlite, jobs } }) {
  @Handle(Record)
  async record(input: Record, delivery: Delivery): Promise<void> {
    await this.#log(input.label, delivery, Date.now());
  }

  @Handle(Flaky, { retry: { attempts: 3, after: ['1m', '5m'] } })
  async flaky(input: Flaky, delivery: Delivery): Promise<void> {
    await this.#log(input.label, delivery, Date.now());
    throw new Error(`flaky ${input.label}`);
  }

  @Handle(Fatal)
  async fatal(input: Fatal, delivery: Delivery): Promise<void> {
    await this.#log(input.label, delivery, Date.now());
    throw new NonRetryableError(`fatal ${input.label}`);
  }

  @Handle(Slow)
  async slow(input: Slow, delivery: Delivery): Promise<void> {
    const started = Date.now();
    await sleep(input.ms);
    await this.#log(input.label, delivery, started);
  }

  @Handle(Again)
  async again(input: Again, delivery: Delivery): Promise<void> {
    await this.#log(`${input.key}:${input.times}`, delivery, Date.now());

    if (input.times > 0) {
      await this.jobs.enqueue(Again, { key: input.key, times: input.times - 1 }, { dedupeKey: input.key });
    }
  }

  async #log(label: string, delivery: Delivery, started: number): Promise<void> {
    await this.db.run(
      'INSERT INTO runs (label, attempt, envelope, started, ended) VALUES (?, ?, ?, ?, ?)',
      label,
      delivery.attempt,
      delivery.envelope.id,
      started,
      Date.now(),
    );
  }
}
