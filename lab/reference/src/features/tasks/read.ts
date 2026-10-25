import { assertLive, loadTask } from '../../domain/load.ts';
import { ok } from '../../http/respond.ts';
import type { Ctx, Result } from '../../http/types.ts';
import { serializeTaskFor } from './serialize.ts';

export function getTask(ctx: Ctx): Result {
  const { workspace, project, task } = loadTask(ctx, ctx.params.id);
  assertLive(workspace, project, task);
  ctx.input();

  return ok(serializeTaskFor(ctx, task), task.version);
}
