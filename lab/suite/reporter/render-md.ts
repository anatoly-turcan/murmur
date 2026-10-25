import { readFileSync, writeFileSync } from 'node:fs';
import { CATEGORY_TITLES, type ResultsFile, type Stats } from './model.ts';

const [input = 'out/results.json', output = 'out/results.md', note = ''] = process.argv.slice(2);
const results = JSON.parse(readFileSync(input, 'utf8')) as ResultsFile;

const pct = (s: Stats): string => (s.passRate === null ? 'n/a' : `${(s.passRate * 100).toFixed(1)}%`);
const row = (label: string, s: Stats): string => `| ${label} | ${s.total} | ${s.passed} | ${s.failed} | ${s.skipped} | ${pct(s)} |`;
const cell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim().slice(0, 240);
const header = '| | Tests | Pass | Fail | Skip | Pass rate |\n|---|---:|---:|---:|---:|---:|';

function render(r: ResultsFile): string {
  const s = r.summary;
  const lines: string[] = [];
  lines.push('# Taskwell hidden suite results', '');
  lines.push(`Generated ${r.generatedAt} against \`${r.baseUrl ?? 'unknown'}\`. Run complete: **${r.complete ? 'yes' : 'no'}**.`);
  if (note) lines.push('', `> ${note}`);
  lines.push('', `Pass rate = ${r.passRateDefinition}.`, '', '## Summary', '', header);
  lines.push(row('**Overall**', s.totals), row('Happy path (smoke)', s.kinds.happy), row('Traps (A–L, CR)', s.kinds.trap), row('Endpoint errors', s.kinds.errors));
  lines.push('', `## By suite (mode ${s.cr ?? 'none'})`, '', header);
  for (const [suite, st] of Object.entries(s.byCr ?? {})) lines.push(row(suite, st));
  lines.push('', '## By category', '', header);
  for (const [c, st] of Object.entries(s.byCategory)) lines.push(row(`${c} — ${CATEGORY_TITLES[c] ?? c}`, st));
  lines.push('', '## By TRAPS row', '', '| Id | Verdict | Tests | Pass | Fail | Skip |', '|---|---|---:|---:|---:|---:|');
  for (const [id, st] of Object.entries(s.byTrap)) lines.push(`| ${id} | ${st.verdict} | ${st.total} | ${st.passed} | ${st.failed} | ${st.skipped} |`);
  if (r.harnessErrors.length) {
    lines.push('', '## Harness errors', '', '| File | Message |', '|---|---|');
    for (const e of r.harnessErrors) lines.push(`| ${e.file} | ${cell(e.message)} |`);
  }
  const failed = r.tests.filter((t) => t.status === 'fail');
  lines.push('', `## Failed tests (${failed.length})`, '', '| Test | Category | Classification | Message |', '|---|---|---|---|');
  for (const t of failed) lines.push(`| ${cell(t.name)} | ${t.category} | ${t.classification === undefined ? '' : (t.classification ?? '_null_')} | ${cell(t.message)} |`);
  const skipped = r.tests.filter((t) => t.status === 'skip' || t.status === 'todo');
  if (skipped.length) {
    lines.push('', `## Skipped tests (${skipped.length})`, '', '| Test | Reason |', '|---|---|');
    for (const t of skipped) lines.push(`| ${cell(t.name)} | ${cell(t.message)} |`);
  }
  const noted = r.tests.filter((t) => t.diagnostics?.length);
  if (noted.length) {
    lines.push('', '## Diagnostics for reviewers', '', '| Test | Status | Notes |', '|---|---|---|');
    for (const t of noted) lines.push(`| ${cell(t.name)} | ${t.status} | ${cell(t.diagnostics!.join(' / '))} |`);
  }

  return `${lines.join('\n')}\n`;
}

writeFileSync(output, render(results));
console.log(`wrote ${output}`);
