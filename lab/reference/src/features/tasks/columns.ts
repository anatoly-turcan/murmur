import type { BudgetInput } from '../../http/validate.ts';
import { fold } from '../../text/normalize.ts';

export function labelColumns(labels: readonly string[]): { labels: string; labels_fold: string } {
  return { labels: JSON.stringify(labels), labels_fold: JSON.stringify(labels.map(fold)) };
}

export function budgetColumns(budget: BudgetInput | null): { budget_currency: string | null; budget_minor: string | null } {
  return budget ? { budget_currency: budget.currency, budget_minor: budget.minor.toString() } : { budget_currency: null, budget_minor: null };
}

export function foldOrNull(text: string | null): string | null {
  return text === null ? null : fold(text);
}

export function completedAtFor(status: string, previous: number | null, now: number): number | null {
  if (status !== 'done') return null;

  return previous ?? now;
}
