import { sliceA } from './a.ts';
import { sliceAudit } from './audit.ts';
import { sliceB } from './b.ts';
import { sliceC } from './c.ts';
import { sliceD } from './d.ts';
import { sliceOrganizations } from './organizations.ts';
import type { SchedulerRule, Slice } from './types.ts';

export const SLICES: readonly Slice[] = [sliceA, sliceB, sliceC, sliceD, sliceOrganizations, sliceAudit];

export function schedulerRules(slices: readonly Slice[] = SLICES): SchedulerRule[] {
  return slices.flatMap((s) => s.schedulerRules);
}

export function seeder(slices: readonly Slice[] = SLICES): Slice['seed'] {
  return slices.find((s) => s.seed)?.seed;
}
