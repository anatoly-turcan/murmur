import { q } from '../../http/query.ts';
import { byWebhook, byWorkspace } from '../../http/scopes.ts';
import type { Route } from '../../http/types.ts';
import { createWebhook } from './create.ts';
import { DELIVERY_STATUSES, listDeliveries } from './deliveries-list.ts';

export const webhookRoutes: Route[] = [
  { method: 'POST', path: '/v1/workspaces/:id/webhooks', idempotent: true, scope: byWorkspace(), handle: createWebhook },
  {
    method: 'GET',
    path: '/v1/webhooks/:id/deliveries',
    list: true,
    query: { status: q.enumList(DELIVERY_STATUSES) },
    scope: byWebhook(),
    handle: listDeliveries,
  },
];
