import type { DatabaseSync } from 'node:sqlite';
import { withLegacyIds } from '../ids/payload.ts';
import { enqueue, type JobRef } from '../jobs/queue.ts';
import type { Id } from '../ids/uuid.ts';

export type EmailTemplate = 'member_added' | 'task_assigned' | 'comment_added' | 'task_due' | 'daily_digest' | 'audit_export_ready';

export interface EmailInput {
  template: EmailTemplate;
  toUserId: Id;
  subject: string;
  dedupeKey: string;
  data: Record<string, unknown>;
  requireMemberOf?: Id;
}

export interface EmailJobPayload {
  template: EmailTemplate;
  to_user_id: Id;
  subject: string;
  dedupe_key: string;
  data: Record<string, unknown>;
  require_member_of: Id | null;
  check_sink?: boolean;
}

export function enqueueEmail(db: DatabaseSync, now: number, input: EmailInput): JobRef {
  const payload: EmailJobPayload = {
    template: input.template,
    to_user_id: input.toUserId,
    subject: input.subject,
    dedupe_key: input.dedupeKey,
    data: withLegacyIds(db, now, input.data),
    require_member_of: input.requireMemberOf ?? null,
  };

  return enqueue(db, { type: 'email', payload, runAt: now, now });
}
