import type { DatabaseSync } from 'node:sqlite';
import { loadUser } from '../../domain/actor.ts';
import { enqueueEmail } from '../../domain/emails.ts';
import { jobPayload, succeeded, type JobHandler } from '../../jobs/types.ts';
import { composeDigest } from './compose.ts';
import type { DigestJobPayload } from './rule.ts';

function sendDigest(db: DatabaseSync, p: DigestJobPayload, now: number): void {
  const user = loadUser(db, p.user_id);
  if (!user || user.deactivated_at !== null || user.digest_enabled !== 1) return;
  enqueueEmail(db, now, {
    template: 'daily_digest',
    toUserId: user.id,
    subject: `Your Taskwell digest for ${p.date}`,
    dedupeKey: `daily_digest:${user.id}:${p.date}`,
    data: { ...composeDigest(db, user.id, p.date, p.timezone, now) },
  });
}

export const digestJob: JobHandler = {
  async run(job, ctx) {
    const payload = jobPayload<DigestJobPayload>(job);

    return succeeded({ apply: () => sendDigest(ctx.db, payload, ctx.now()) });
  },
};
