import { assertLive, loadComment } from '../../domain/load.ts';
import { ok } from '../../http/respond.ts';
import type { Ctx, Result } from '../../http/types.ts';
import { serializeComment } from './serialize.ts';

export function getComment(ctx: Ctx): Result {
  const { workspace, project, task, comment } = loadComment(ctx, ctx.params.id);
  assertLive(workspace, project, task, comment);
  ctx.input();

  return ok(serializeComment(ctx.db, comment), comment.version);
}
