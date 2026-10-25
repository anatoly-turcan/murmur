import { test, type TestContext, type TestOptions } from 'node:test';
import { crLevel, crMode, type CrId } from './cr-mode.ts';

export { CHANGE_REQUESTS, crLevel, crMode, parseCrMode, type CrId, type CrMode } from './cr-mode.ts';

// Modes are cumulative: CR-2 means CR-1 has been delivered too.
export function crApplied(cr: CrId): boolean {
  return crLevel(crMode) >= crLevel(cr);
}

export function crSkip(cr: CrId): string | false {
  return crApplied(cr) ? false : `${cr} tests run only with SUITE_CR=${cr} or later (current: ${crMode})`;
}

export function obsoleteIn(cr: CrId, reason: string): string | false {
  return crApplied(cr) ? `obsolete under ${cr}: ${reason}` : false;
}

type Body = (t: TestContext) => void | Promise<void>;

export function crTest(cr: CrId): (name: string, fnOrOptions: Body | TestOptions, maybeFn?: Body) => void {
  return (name, fnOrOptions, maybeFn) => {
    const options = typeof fnOrOptions === 'function' ? {} : fnOrOptions;
    const fn = typeof fnOrOptions === 'function' ? fnOrOptions : maybeFn!;
    const skip = crSkip(cr) || options.skip;
    test(name, { ...options, skip }, fn);
  };
}
