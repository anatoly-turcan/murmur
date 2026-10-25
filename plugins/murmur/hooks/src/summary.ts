import { runCheck, type CheckOutcome, type Finding } from './check.ts';
import type { Target } from './target.ts';

export interface Report {
  readonly text: string;
  readonly blocking: boolean;
}

export type HookOutput =
  | { readonly decision: 'block'; readonly reason: string }
  | {
      readonly hookSpecificOutput: {
        readonly hookEventName: 'PostToolUse' | 'SessionStart';
        readonly additionalContext: string;
      };
    };

export type StopOutput =
  | { readonly decision: 'block'; readonly reason: string }
  | { readonly systemMessage: string };

const MAX_LINES = 20;

function line(f: Finding): string {
  const help = f.help === undefined ? '' : ` (${f.help})`;

  return `- ${f.file}:${f.line}:${f.col} ${f.severity} ${f.rule}: ${f.message}${help}`;
}

function count(findings: readonly Finding[], severity: Finding['severity']): number {
  return findings.filter((f) => f.severity === severity).length;
}

function findingsText(target: Target, findings: readonly Finding[]): string {
  const errors = count(findings, 'error');
  const warnings = count(findings, 'warn');
  const head = `murmur check ${target.key}: ${errors} error(s), ${warnings} warn(s)`;
  const rest =
    findings.length > MAX_LINES ? [`- … ${findings.length - MAX_LINES} more (murmur check --json)`] : [];

  return [head, ...findings.slice(0, MAX_LINES).map(line), ...rest].join('\n');
}

export function reportOf(target: Target, outcome: CheckOutcome): Report | null {
  if (outcome.kind === 'failure') {
    return { text: `murmur check ${target.key} could not run:\n${outcome.message}`, blocking: false };
  }

  if (outcome.findings.length === 0) {
    return null;
  }

  return { text: findingsText(target, outcome.findings), blocking: count(outcome.findings, 'error') > 0 };
}

export function checkReports(targets: readonly Target[]): Report[] {
  return targets.flatMap((target) => {
    const report = reportOf(target, runCheck(target));

    return report === null ? [] : [report];
  });
}

export function context(hookEventName: 'PostToolUse' | 'SessionStart', text: string): HookOutput {
  return { hookSpecificOutput: { hookEventName, additionalContext: text } };
}

export function postToolUseOutput(reports: readonly Report[]): HookOutput | null {
  if (reports.length === 0) {
    return null;
  }

  const text = reports.map((report) => report.text).join('\n\n');

  return reports.some((report) => report.blocking)
    ? { decision: 'block', reason: text }
    : context('PostToolUse', text);
}

export function stopOutput(reports: readonly Report[], stopHookActive: boolean): StopOutput | null {
  const blocking = reports.filter((report) => report.blocking);
  if (blocking.length === 0) {
    return null;
  }

  const text = blocking.map((report) => report.text).join('\n\n');
  if (stopHookActive) {
    return { systemMessage: text };
  }

  return { decision: 'block', reason: `${text}\n\nFix these before finishing (murmur check on the app).` };
}

export function writeOutput(output: object | null): void {
  if (output !== null) {
    process.stdout.write(`${JSON.stringify(output)}\n`);
  }
}
