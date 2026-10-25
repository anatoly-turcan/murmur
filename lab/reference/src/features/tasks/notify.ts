import type { DatabaseSync } from 'node:sqlite';
import { enqueueEmail } from '../../domain/emails.ts';
import type { TaskRow, UserRow } from '../../domain/rows.ts';
import type { Id } from '../../ids/uuid.ts';

export function notifyAssigned(db: DatabaseSync, now: number, task: TaskRow, actor: UserRow, eventId: Id): void {
  if (task.assignee_id === null || task.assignee_id === actor.id) return;
  enqueueEmail(db, now, {
    template: 'task_assigned',
    toUserId: task.assignee_id,
    subject: `You were assigned: ${task.title}`,
    dedupeKey: `task_assigned:${task.id}:${task.assignee_id}:${eventId}`,
    data: { task_id: task.id, task_title: task.title, workspace_id: task.workspace_id, actor_name: actor.name },
  });
}
