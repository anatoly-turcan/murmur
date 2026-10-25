import { ACTIVITY_QUERY, listActivity } from '../features/activity/list.ts';
import { deleteComment, restoreComment } from '../features/comments/lifecycle.ts';
import { listComments } from '../features/comments/list.ts';
import { updateComment } from '../features/comments/update.ts';
import { digestJob } from '../features/digest/job.ts';
import { digestRule } from '../features/digest/rule.ts';
import { reminderJob } from '../features/reminders/job.ts';
import { reminderRule } from '../features/reminders/rule.ts';
import { SEARCH_QUERY, searchTasks } from '../features/search/search.ts';
import { q } from '../http/query.ts';
import { byComment, byTask, byWorkspace } from '../http/scopes.ts';
import type { Route } from '../http/types.ts';
import type { Slice } from './types.ts';

const routes: Route[] = [
  {
    method: 'GET',
    path: '/v1/tasks/:id/comments',
    list: true,
    query: { include_deleted: q.bool(false) },
    scope: byTask(),
    handle: listComments,
  },
  { method: 'PATCH', path: '/v1/comments/:id', ifMatch: true, scope: byComment(), handle: updateComment },
  { method: 'DELETE', path: '/v1/comments/:id', ifMatch: true, scope: byComment(), handle: deleteComment },
  { method: 'POST', path: '/v1/comments/:id/restore', body: 'none', scope: byComment(), handle: restoreComment },
  { method: 'GET', path: '/v1/workspaces/:id/activity', list: true, query: ACTIVITY_QUERY, scope: byWorkspace(), handle: listActivity },
  { method: 'GET', path: '/v1/workspaces/:id/search', list: true, query: SEARCH_QUERY, scope: byWorkspace(), handle: searchTasks },
];

export const sliceC: Slice = {
  name: 'c',
  routes,
  jobHandlers: { digest: digestJob, reminder: reminderJob },
  schedulerRules: [digestRule, reminderRule],
};
