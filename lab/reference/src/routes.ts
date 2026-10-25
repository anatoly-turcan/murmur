import type { Config } from './config.ts';
import { apiKeyRoutes } from './features/api-keys/routes.ts';
import { commentRoutes } from './features/comments/routes.ts';
import { healthRoutes } from './features/health/routes.ts';
import { memberRoutes } from './features/members/routes.ts';
import { projectRoutes } from './features/projects/routes.ts';
import { taskRoutes } from './features/tasks/routes.ts';
import { testingRoutes } from './features/testing/routes.ts';
import { userRoutes } from './features/users/routes.ts';
import { webhookRoutes } from './features/webhooks/routes.ts';
import { workspaceRoutes } from './features/workspaces/routes.ts';
import type { Route } from './http/types.ts';
import { schedulerRules, seeder } from './slices/index.ts';
import type { Slice } from './slices/types.ts';

const KERNEL_ROUTES: Route[] = [
  ...healthRoutes,
  ...userRoutes,
  ...apiKeyRoutes,
  ...workspaceRoutes,
  ...memberRoutes,
  ...projectRoutes,
  ...taskRoutes,
  ...commentRoutes,
  ...webhookRoutes,
];

export function allRoutes(config: Config, slices: readonly Slice[]): Route[] {
  const testing = config.testMode ? testingRoutes({ rules: schedulerRules(slices), seed: seeder(slices) }) : [];

  return [...KERNEL_ROUTES, ...testing, ...slices.flatMap((s) => s.routes)];
}
