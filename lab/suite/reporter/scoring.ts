import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, relative, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { crMode } from '../lib/cr-mode.ts';
import { classify, summarize, type ResultsFile, type Status, type TestResult } from './model.ts';

const OUTPUT = resolve(process.env.SUITE_RESULTS_JSON ?? 'out/results.json');
const SUITE_ROOT = resolve(import.meta.dirname, '..');
const PRELOAD = process.env.SUITE_RESULTS_PRELOAD;

// run.sh runs the pre-migration (legacy) files in a first node invocation; their results are carried into this one.
function preloaded(): Pick<ResultsFile, 'tests' | 'harnessErrors'> {
  if (!PRELOAD) return { tests: [], harnessErrors: [] };
  const earlier = JSON.parse(readFileSync(PRELOAD, 'utf8')) as ResultsFile;

  return { tests: earlier.tests, harnessErrors: earlier.harnessErrors };
}

function messageOf(error: any): string {
  if (!error) return '';
  const inner = error.cause ?? error;
  const text = inner?.message ?? String(inner);

  return String(text).slice(0, 4000);
}

function statusOf(data: any, failed: boolean): Status {
  if (failed) return 'fail';
  if (data.skip !== undefined && data.skip !== false) return 'skip';
  if (data.todo !== undefined && data.todo !== false) return 'todo';

  return 'pass';
}

function isFileLevel(data: any): boolean {
  return Boolean(data.file) && (data.name === basename(data.file) || data.name === data.file || resolve(data.name) === data.file);
}

function write(file: ResultsFile): void {
  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, `${JSON.stringify(file, null, 2)}\n`);
}

function snapshot(tests: TestResult[], harnessErrors: ResultsFile['harnessErrors'], complete: boolean): ResultsFile {
  for (const t of tests) {
    if (t.kind === 'trap' && t.status === 'fail') t.classification ??= null;
  }

  return {
    generatedAt: new Date().toISOString(),
    complete,
    baseUrl: process.env.TASKWELL_BASE_URL ?? null,
    passRateDefinition: 'passed / (passed + failed); skipped and todo tests are excluded',
    summary: summarize(tests, crMode),
    harnessErrors,
    tests,
  };
}

export default async function* scoring(source: AsyncIterable<{ type: string; data: any }>): AsyncGenerator<string> {
  const { tests, harnessErrors } = preloaded();
  const lastByFile = new Map<string, TestResult>();
  for await (const event of source) {
    const { type, data } = event;
    if (type === 'test:diagnostic' && data.file && lastByFile.has(data.file)) {
      const last = lastByFile.get(data.file)!;
      (last.diagnostics ??= []).push(String(data.message));
      continue;
    }
    if (type !== 'test:pass' && type !== 'test:fail') continue;
    if (data.details?.type === 'suite') continue;
    const failed = type === 'test:fail';
    if (isFileLevel(data)) {
      const failureType = data.details?.error?.failureType;
      if (failed && failureType !== 'subtestsFailed') {
        harnessErrors.push({ file: relative(SUITE_ROOT, data.file), message: messageOf(data.details?.error) });
        write(snapshot(tests, harnessErrors, false));
      }
      continue;
    }
    const result: TestResult = {
      name: data.name,
      file: data.file ? relative(SUITE_ROOT, data.file) : '',
      ...classify(data.name),
      status: statusOf(data, failed),
      durationMs: Math.round(data.details?.duration_ms ?? 0),
      message: failed ? messageOf(data.details?.error) : typeof data.skip === 'string' ? data.skip : '',
    };
    tests.push(result);
    if (data.file) lastByFile.set(data.file, result);
    write(snapshot(tests, harnessErrors, false));
  }
  const final = snapshot(tests, harnessErrors, true);
  write(final);
  const t = final.summary.totals;
  yield `scoring: ${t.passed} passed, ${t.failed} failed, ${t.skipped} skipped of ${t.total}; pass rate ${t.passRate ?? 'n/a'} → ${OUTPUT}\n`;
}
