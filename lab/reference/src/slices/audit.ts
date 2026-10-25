import { downloadExport, auditExportJob, requestExport } from '../features/audit/exports.ts';
import { AUDIT_QUERY } from '../features/audit/query.ts';
import { getAuditEntry, listMyAudit, listOrganizationAudit, listWorkspaceAudit } from '../features/audit/read.ts';
import { auditRetentionJob, enqueueAuditRetention } from '../features/audit/retention.ts';
import { auditStats } from '../features/audit/stats.ts';
import { byWorkspace } from '../http/scopes.ts';
import type { Route } from '../http/types.ts';
import type { Slice } from './types.ts';

const ORG_AUDIT = '/v1/organizations/:id/audit';

const routes: Route[] = [
  { method: 'GET', path: '/v1/workspaces/:id/audit', list: true, query: AUDIT_QUERY, scope: byWorkspace(), handle: listWorkspaceAudit },
  { method: 'GET', path: ORG_AUDIT, list: true, query: AUDIT_QUERY, handle: listOrganizationAudit },
  { method: 'GET', path: `${ORG_AUDIT}/stats`, handle: auditStats },
  { method: 'POST', path: `${ORG_AUDIT}/exports`, idempotent: true, handle: requestExport },
  { method: 'GET', path: `${ORG_AUDIT}/exports/:export_id`, handle: downloadExport },
  { method: 'GET', path: '/v1/users/me/audit', list: true, query: AUDIT_QUERY, handle: listMyAudit },
  { method: 'GET', path: '/v1/audit/:id', handle: getAuditEntry },
];

export const sliceAudit: Slice = {
  name: 'audit',
  routes,
  jobHandlers: { audit_retention: auditRetentionJob, audit_export: auditExportJob },
  schedulerRules: [{ run: enqueueAuditRetention }],
};
