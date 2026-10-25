import type { DatabaseSync } from 'node:sqlite';
import { one } from '../../db/sql.ts';
import { enqueueEmail } from '../../domain/emails.ts';
import type { TaskRow } from '../../domain/rows.ts';
import { jobPayload, succeeded, type JobHandler } from '../../jobs/types.ts';
import type { ReminderJobPayload } from './rule.ts';

function stillDue(db: DatabaseSync, p: ReminderJobPayload): TaskRow | undefined {
  return one<TaskRow>(
    db,
    `SELECT t.* FROM tasks t
       JOIN projects p ON p.id = t.project_id AND p.deleted_at IS NULL
       JOIN workspaces w ON w.id = t.workspace_id AND w.deleted_at IS NULL
      WHERE t.id = ? AND t.deleted_at IS NULL AND t.status <> 'done' AND t.assignee_id = ? AND t.due_date = ?`,
    p.task_id,
    p.assignee_id,
    p.due_date,
  );
}

function sendReminder(db: DatabaseSync, p: ReminderJobPayload, now: number): void {
  const task = stillDue(db, p);
  if (!task) return;
  enqueueEmail(db, now, {
    template: 'task_due',
    toUserId: p.assignee_id,
    subject: `Due today: ${task.title}`,
    dedupeKey: `task_due:${task.id}:${p.due_date}`,
    data: { task_id: task.id, task_title: task.title, due_date: p.due_date, workspace_id: task.workspace_id },
    requireMemberOf: task.workspace_id,
  });
}

export const reminderJob: JobHandler = {
  async run(job, ctx) {
    const payload = jobPayload<ReminderJobPayload>(job);

    return succeeded({ apply: () => sendReminder(ctx.db, payload, ctx.now()) });
  },
};
