import type { Slice } from '../slices/types.ts';
import { emailJob } from './email-job.ts';
import { maintenanceJob } from './maintenance-job.ts';
import type { JobHandlers, JobType } from './types.ts';

const KERNEL_HANDLERS: JobHandlers = { email: emailJob, maintenance: maintenanceJob };

export function buildHandlers(slices: readonly Slice[]): JobHandlers {
  const handlers: JobHandlers = { ...KERNEL_HANDLERS };
  for (const slice of slices) {
    for (const [type, handler] of Object.entries(slice.jobHandlers)) {
      if (handlers[type as JobType]) throw new Error(`job handler for ${type} registered twice (slice ${slice.name})`);
      handlers[type as JobType] = handler;
    }
  }

  return handlers;
}
