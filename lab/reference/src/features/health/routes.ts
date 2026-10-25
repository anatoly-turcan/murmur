import { ApiError } from '../../http/errors.ts';
import { ok } from '../../http/respond.ts';
import type { Route } from '../../http/types.ts';
import { scalar } from '../../db/sql.ts';

export const healthRoutes: Route[] = [
  {
    method: 'GET',
    path: '/healthz',
    auth: 'none',
    rateLimit: false,
    handle(ctx) {
      try {
        scalar(ctx.db, 'SELECT 1');
      } catch {
        throw new ApiError(503, 'database_unavailable', 'The database cannot be reached.');
      }

      return ok({ status: 'ok', database: 'ok' });
    },
  },
];
