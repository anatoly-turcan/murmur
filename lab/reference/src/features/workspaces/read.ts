import { assertLive, loadWorkspace } from '../../domain/load.ts';
import { ok } from '../../http/respond.ts';
import type { Ctx, Result } from '../../http/types.ts';
import { serializeWorkspace } from './serialize.ts';

export function getWorkspace(ctx: Ctx): Result {
  const { workspace, role } = loadWorkspace(ctx, ctx.params.id);
  assertLive(workspace);
  ctx.input();

  return ok(serializeWorkspace(workspace, role), workspace.version);
}
