export const MATCHES = ['title_prefix', 'title', 'description', 'comment'] as const;

export type Match = (typeof MATCHES)[number];

export const RANK_SQL = `CASE
    WHEN instr(t.title_fold, ?1) = 1 THEN 1
    WHEN instr(t.title_fold, ?1) > 1 THEN 2
    WHEN instr(coalesce(t.description_fold, ''), ?1) > 0 THEN 3
    WHEN EXISTS (SELECT 1 FROM comments c WHERE c.task_id = t.id AND c.deleted_at IS NULL AND instr(c.body_fold, ?1) > 0) THEN 4
  END`;

export function matchOf(rank: number): Match {
  return MATCHES[rank - 1];
}
