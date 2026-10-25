import { test } from 'node:test';
import { expectError } from '../lib/assert.ts';
import { fill, objectWorld, type Slot } from '../lib/endpoints.ts';
import { deleteOk, registerUser } from '../lib/fixtures.ts';
import type { Id } from '../lib/ids.ts';
import { freshDatabaseEachTest } from '../lib/suite.ts';

freshDatabaseEachTest();

type Parent = 'workspace' | 'project' | 'task';

const PARENT_PATH: Record<Parent, (ids: Record<Slot, Id>) => string> = {
  workspace: (ids) => `/v1/workspaces/${ids.ws}`,
  project: (ids) => `/v1/projects/${ids.project}`,
  task: (ids) => `/v1/tasks/${ids.task}`,
};

const NESTED: [Parent, 'GET' | 'POST', string, unknown?][] = [
  ['workspace', 'GET', '/v1/workspaces/{ws}/members'],
  ['workspace', 'GET', '/v1/workspaces/{ws}/projects'],
  ['workspace', 'GET', '/v1/workspaces/{ws}/tasks'],
  ['workspace', 'GET', '/v1/workspaces/{ws}/activity'],
  ['workspace', 'GET', '/v1/workspaces/{ws}/webhooks'],
  ['workspace', 'POST', '/v1/workspaces/{ws}/projects', { name: 'Late' }],
  ['workspace', 'POST', '/v1/workspaces/{ws}/webhooks', { url: 'http://127.0.0.1:9/x', events: ['*'] }],
  ['workspace', 'GET', '/v1/projects/{project}/tasks'],
  ['workspace', 'GET', '/v1/projects/{project}/summary'],
  ['workspace', 'GET', '/v1/webhooks/{webhook}'],
  ['workspace', 'GET', '/v1/webhooks/{webhook}/deliveries'],
  ['workspace', 'GET', '/v1/webhooks/{webhook}/deliveries/{delivery}'],
  ['project', 'GET', '/v1/projects/{project}/tasks'],
  ['project', 'GET', '/v1/projects/{project}/summary'],
  ['project', 'POST', '/v1/projects/{project}/tasks', { title: 'Late' }],
  ['project', 'GET', '/v1/tasks/{task}/comments'],
  ['project', 'POST', '/v1/tasks/{task}/comments', { body: 'Late' }],
  ['project', 'GET', '/v1/comments/{comment}'],
  ['task', 'GET', '/v1/tasks/{task}/comments'],
  ['task', 'POST', '/v1/tasks/{task}/comments', { body: 'Late' }],
];

// SPEC 6.3: lists, summaries and creation nested under a soft-deleted object are 410; non-members still get 404.
for (const [parent, method, path, body] of NESTED) {
  test(`[ERR] ${method} ${path.replace(/\{\w+\}/g, '{id}')} → 410 gone (${parent} deleted)`, async () => {
    const w = await objectWorld();
    await deleteOk(w.owner, PARENT_PATH[parent](w.ids));
    const target = fill(path, w.ids);
    expectError(await w.owner.client.request(method, target, { body }), 410, 'gone');
    expectError(await w.member.client.get(target), 410, 'gone');
    const outsider = await registerUser();
    expectError(await outsider.client.request(method, target, { body }), 404, 'not_found');
  });
}
