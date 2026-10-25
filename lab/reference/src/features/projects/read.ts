import { assertLive, loadProject } from '../../domain/load.ts';
import { ok } from '../../http/respond.ts';
import type { Ctx, Result } from '../../http/types.ts';
import { serializeProject } from './serialize.ts';

export function getProject(ctx: Ctx): Result {
  const { workspace, project } = loadProject(ctx, ctx.params.id);
  assertLive(workspace, project);
  ctx.input();

  return ok(serializeProject(project), project.version);
}
