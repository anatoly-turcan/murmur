import type { TaskRow } from '../../domain/rows.ts';
import type { Ctx } from '../../http/types.ts';
import { money, type Money } from '../../money/money.ts';
import { iso, isoOrNull } from '../../time/format.ts';
import { localDate } from '../../time/zones.ts';

export function isOverdue(task: Pick<TaskRow, 'status' | 'due_date'>, timezone: string, now: number): boolean {
  return task.status !== 'done' && task.due_date !== null && task.due_date < localDate(now, timezone);
}

export function taskBudget(task: Pick<TaskRow, 'budget_currency' | 'budget_minor'>): Money | null {
  return task.budget_currency && task.budget_minor !== null ? money(task.budget_currency, BigInt(task.budget_minor)) : null;
}

export function serializeTask(task: TaskRow, timezone: string, now: number): Record<string, unknown> {
  return {
    id: task.id,
    project_id: task.project_id,
    workspace_id: task.workspace_id,
    title: task.title,
    description: task.description,
    status: task.status,
    labels: JSON.parse(task.labels),
    assignee_id: task.assignee_id,
    creator_id: task.creator_id,
    due_date: task.due_date,
    overdue: isOverdue(task, timezone, now),
    estimate_minutes: task.estimate_minutes,
    budget: taskBudget(task),
    version: task.version,
    completed_at: isoOrNull(task.completed_at),
    created_at: iso(task.created_at),
    updated_at: iso(task.updated_at),
    deleted_at: isoOrNull(task.deleted_at),
  };
}

export function serializeTaskFor(ctx: Ctx, task: TaskRow): Record<string, unknown> {
  return serializeTask(task, ctx.me().timezone, ctx.now);
}
