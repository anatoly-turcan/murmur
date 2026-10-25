import type { DatabaseSync } from 'node:sqlite';
import { all, run } from '../../db/sql.ts';
import { enqueue } from '../../jobs/queue.ts';
import type { SchedulerRule } from '../../slices/types.ts';
import { localDateIfPast } from '../digest/rule.ts';
import type { Id } from '../../ids/uuid.ts';

export const REMINDER_HOUR = 9;

export interface ReminderJobPayload {
  task_id: Id;
  due_date: string;
  assignee_id: Id;
}

interface Candidate {
  task_id: Id;
  due_date: string;
  assignee_id: Id;
  timezone: string;
}

function utcDateShift(now: number, days: number): string {
  return Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO('UTC').toPlainDate().add({ days }).toString();
}

function candidates(db: DatabaseSync, now: number): Candidate[] {
  return all<Candidate>(
    db,
    `SELECT t.id AS task_id, t.due_date, t.assignee_id, u.timezone FROM tasks t
       JOIN users u ON u.id = t.assignee_id AND u.deactivated_at IS NULL
       JOIN projects p ON p.id = t.project_id AND p.deleted_at IS NULL
       JOIN workspaces w ON w.id = t.workspace_id AND w.deleted_at IS NULL
      WHERE t.deleted_at IS NULL AND t.status <> 'done' AND t.assignee_id IS NOT NULL
        AND t.due_date BETWEEN ? AND ?`,
    utcDateShift(now, -1),
    utcDateShift(now, 1),
  );
}

function isDue(c: Candidate, now: number, zoneDates: Map<string, string | null>): boolean {
  if (!zoneDates.has(c.timezone)) zoneDates.set(c.timezone, localDateIfPast(now, c.timezone, REMINDER_HOUR));

  return zoneDates.get(c.timezone) === c.due_date;
}

function claimReminder(db: DatabaseSync, c: Candidate, now: number): boolean {
  return run(db, 'INSERT OR IGNORE INTO reminder_runs (task_id, due_date, created_at) VALUES (?, ?, ?)', c.task_id, c.due_date, now) === 1;
}

function scheduleReminders(db: DatabaseSync, now: number): number {
  const zoneDates = new Map<string, string | null>();
  const due = candidates(db, now).filter((c) => isDue(c, now, zoneDates) && claimReminder(db, c, now));
  for (const c of due) {
    const payload: ReminderJobPayload = { task_id: c.task_id, due_date: c.due_date, assignee_id: c.assignee_id };
    enqueue(db, { type: 'reminder', payload, runAt: now, now });
  }

  return due.length;
}

export const reminderRule: SchedulerRule = { counter: 'reminders_created', run: scheduleReminders };
