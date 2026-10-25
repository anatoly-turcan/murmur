import { byWebhook, byWorkspace } from '../http/scopes.ts';
import type { Route } from '../http/types.ts';
import { webhookDeliveryJob } from '../features/webhooks/delivery/job.ts';
import { getDelivery } from '../features/webhooks/delivery-read.ts';
import { listWebhooks } from '../features/webhooks/list.ts';
import { getWebhook } from '../features/webhooks/read.ts';
import { redeliver } from '../features/webhooks/redeliver.ts';
import { removeWebhook } from '../features/webhooks/remove.ts';
import { updateWebhook } from '../features/webhooks/update.ts';
import type { Slice } from './types.ts';

const routes: Route[] = [
  { method: 'GET', path: '/v1/workspaces/:id/webhooks', list: true, scope: byWorkspace(), handle: listWebhooks },
  { method: 'GET', path: '/v1/webhooks/:id', scope: byWebhook(), handle: getWebhook },
  { method: 'PATCH', path: '/v1/webhooks/:id', scope: byWebhook(), handle: updateWebhook },
  { method: 'DELETE', path: '/v1/webhooks/:id', scope: byWebhook(), handle: removeWebhook },
  { method: 'GET', path: '/v1/webhooks/:id/deliveries/:delivery_id', scope: byWebhook(), handle: getDelivery },
  {
    method: 'POST',
    path: '/v1/webhooks/:id/deliveries/:delivery_id/redeliver',
    body: 'none',
    scope: byWebhook(),
    handle: redeliver,
  },
];

export const sliceD: Slice = {
  name: 'd',
  routes,
  jobHandlers: { webhook_delivery: webhookDeliveryJob },
  schedulerRules: [],
};
