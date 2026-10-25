import type { DatabaseSync } from 'node:sqlite';
import { all, one } from '../../db/sql.ts';
import { assertLive, loadProject } from '../../domain/load.ts';
import { ok } from '../../http/respond.ts';
import type { Ctx, Result } from '../../http/types.ts';
import { decimalsOf, formatMinor, meanHalfAwayFromZero } from '../../money/money.ts';
import { localDate } from '../../time/zones.ts';
import type { Id } from '../../ids/uuid.ts';

interface Totals {
  open: number;
  in_progress: number;
  done: number;
  total: number;
  overdue: number;
  estimate: number;
}

interface BudgetRow {
  budget_currency: string;
  budget_minor: string;
}

function totals(db: DatabaseSync, projectId: Id, today: string): Totals {
  return one<Totals>(
    db,
    `SELECT COALESCE(SUM(status = 'open'), 0) AS open, COALESCE(SUM(status = 'in_progress'), 0) AS in_progress,
            COALESCE(SUM(status = 'done'), 0) AS done, COUNT(*) AS total,
            COALESCE(SUM(status <> 'done' AND due_date IS NOT NULL AND due_date < ?2), 0) AS overdue,
            COALESCE(SUM(estimate_minutes), 0) AS estimate
       FROM tasks WHERE project_id = ?1 AND deleted_at IS NULL`,
    projectId,
    today,
  )!;
}

function budgetSums(db: DatabaseSync, projectId: Id): Map<string, { count: bigint; total: bigint }> {
  const rows = all<BudgetRow>(
    db,
    `SELECT budget_currency, budget_minor FROM tasks
      WHERE project_id = ? AND deleted_at IS NULL AND budget_currency IS NOT NULL ORDER BY budget_currency`,
    projectId,
  );
  const sums = new Map<string, { count: bigint; total: bigint }>();
  for (const row of rows) {
    const sum = sums.get(row.budget_currency) ?? { count: 0n, total: 0n };
    sums.set(row.budget_currency, { count: sum.count + 1n, total: sum.total + BigInt(row.budget_minor) });
  }

  return sums;
}

function budgetEntry(currency: string, count: bigint, total: bigint): Record<string, unknown> {
  const decimals = decimalsOf(currency);
  const mean = meanHalfAwayFromZero(total, count);

  return {
    currency,
    count: Number(count),
    total: formatMinor(total, decimals),
    total_minor: total.toString(),
    mean: formatMinor(mean, decimals),
    mean_minor: mean.toString(),
  };
}

export function projectSummary(ctx: Ctx): Result {
  const { workspace, project } = loadProject(ctx, ctx.params.id);
  assertLive(workspace, project);
  ctx.input();
  const t = totals(ctx.db, project.id, localDate(ctx.now, ctx.me().timezone));
  const budgets = [...budgetSums(ctx.db, project.id)].map(([currency, s]) => budgetEntry(currency, s.count, s.total));

  return ok({
    project_id: project.id,
    task_counts: { open: t.open, in_progress: t.in_progress, done: t.done, total: t.total },
    overdue_count: t.overdue,
    estimate_minutes_total: t.estimate,
    budgets,
  });
}
