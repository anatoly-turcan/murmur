import type { DatabaseSync } from 'node:sqlite';
import { all, scalar } from '../../db/sql.ts';
import type { Id } from '../../ids/uuid.ts';

const DAY_MS = 86_400_000;

export interface DigestTaskItem {
  task_id: Id;
  title: string;
  due_date: string;
  project_id: Id;
  workspace_id: Id;
}

export interface DigestData {
  date: string;
  timezone: string;
  overdue: DigestTaskItem[];
  due_today: DigestTaskItem[];
  activity_count: number;
  organizations: { id: Id; name: string }[];
}

const LIVE_TASKS = `FROM tasks t
    JOIN projects p ON p.id = t.project_id AND p.deleted_at IS NULL
    JOIN workspaces w ON w.id = t.workspace_id AND w.deleted_at IS NULL`;

const ASSIGNED_TO = 'WHERE t.assignee_id = ?1 AND t.deleted_at IS NULL';

function dueTasks(db: DatabaseSync, userId: Id, date: string, comparison: '<' | '='): DigestTaskItem[] {
  return all<DigestTaskItem>(
    db,
    `SELECT t.id AS task_id, t.title, t.due_date, t.project_id, t.workspace_id ${LIVE_TASKS} ${ASSIGNED_TO}
       AND t.status <> 'done' AND t.due_date IS NOT NULL AND t.due_date ${comparison} ?2
     ORDER BY t.due_date, t.id`,
    userId,
    date,
  );
}

function activityCount(db: DatabaseSync, userId: Id, now: number): number {
  return (
    scalar<number>(
      db,
      `SELECT count(*) ${LIVE_TASKS}
         JOIN activity_events e ON e.target_type = 'task' AND e.target_id = t.id
          AND e.occurred_at > ?2 AND e.occurred_at <= ?3 AND e.actor_id <> ?1
        ${ASSIGNED_TO}`,
      userId,
      now - DAY_MS,
      now,
    ) ?? 0
  );
}

function organizationsOf(db: DatabaseSync, tasks: DigestTaskItem[]): { id: Id; name: string }[] {
  const workspaceIds = [...new Set(tasks.map((t) => t.workspace_id))];
  if (workspaceIds.length === 0) return [];

  return all<{ id: Id; name: string }>(
    db,
    `SELECT DISTINCT o.id, o.name FROM organizations o JOIN workspaces w ON w.organization_id = o.id
      WHERE w.id IN (SELECT value FROM json_each(?)) ORDER BY o.id`,
    JSON.stringify(workspaceIds),
  );
}

export function composeDigest(db: DatabaseSync, userId: Id, date: string, timezone: string, now: number): DigestData {
  const overdue = dueTasks(db, userId, date, '<');
  const dueToday = dueTasks(db, userId, date, '=');

  return {
    date,
    timezone,
    overdue,
    due_today: dueToday,
    activity_count: activityCount(db, userId, now),
    organizations: organizationsOf(db, [...overdue, ...dueToday]),
  };
}
