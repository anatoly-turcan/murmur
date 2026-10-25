import { date, id, int, list, money, nullable, oneOf, str, type FieldSpecs } from '../../http/validate.ts';
import { fold } from '../../text/normalize.ts';

export const TASK_STATUSES = ['open', 'in_progress', 'done'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

const TASK_FIELDS = {
  title: str({ max: 200 }),
  description: nullable(str({ min: 0, max: 20_000 })),
  status: oneOf(TASK_STATUSES),
  labels: list(str({ min: 1, max: 40 }), { max: 20, uniqueBy: fold }),
  assignee_id: nullable(id()),
  due_date: nullable(date()),
  estimate_minutes: nullable(int({ min: 0, max: 100_000 })),
  budget: nullable(money()),
} satisfies FieldSpecs;

export const TASK_CREATE_FIELDS = TASK_FIELDS;

export const TASK_PATCH_FIELDS = { ...TASK_FIELDS, project_id: id() } satisfies FieldSpecs;
