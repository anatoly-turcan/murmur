import type { Analysis } from './analyze.ts';
import { withLanes } from './catalog.ts';
import { HEADINGS } from './context-headings.ts';
import {
  bodySections,
  type Include,
  INCLUDES,
  type Includes,
  type Level,
  type Section,
} from './context-sections.ts';
import { ownedStorage, withStorage } from './context-storage.ts';
import { contextSubject, type ContextSubject } from './context-subject.ts';
import type { LaneName, LaneValue } from './lanes.ts';
import { table } from './markdown.ts';
import { ctxCommand } from './piece-commands.ts';
import type { Regeneration, RegenerationReason } from './regeneration.ts';
import { estimateTokens } from './tokens.ts';
import type { Catalog, Limits } from './types.ts';

export interface ContextOptions {
  readonly budget: number | null;
  readonly withholdCode?: boolean;
  readonly include?: readonly Include[];
}

export interface RegenerationReport {
  readonly reason: RegenerationReason;
  readonly lanes: Readonly<Record<LaneName, LaneValue>>;
}

export interface SectionReport {
  readonly id: string;
  readonly title: string;
  readonly tokens: number;
  readonly level: Level;
  readonly text: string;
}

export type Sizing = 'ok' | 'large' | 'warn' | 'fail';

export interface ContextResult {
  readonly piece: string;
  readonly markdown: string;
  readonly sections: readonly SectionReport[];
  readonly tokens: number;
  readonly fullTokens: number;
  readonly budget: number | null;
  readonly overBudget: boolean;
  readonly sizing: Sizing;
  readonly limits: Pick<Limits, 'ctxLargeTokens' | 'ctxWarnTokens' | 'ctxFailTokens'>;
  readonly error: string | null;
  readonly regeneration: RegenerationReport | null;
}

interface FooterInput {
  readonly id: string;
  readonly budget: number | null;
  readonly withholdCode: boolean;
  readonly include: readonly Include[];
  readonly limits: Limits;
  readonly error: string | null;
}

interface Totals {
  readonly printed: number;
  readonly full: number;
}

type Footer = (report: readonly SectionReport[], printed: number) => string;

interface Brief {
  readonly tokens: number;
  readonly footer: string;
}

const FIXED_POINT_ROUNDS = 10;

const SHRINK_ORDER = [5, 4, 3, 2, 1] as const;

function reportOf(sections: readonly Section[], levels: ReadonlyMap<string, Level>): SectionReport[] {
  return sections.map((s) => {
    const level = levels.get(s.id) ?? 0;
    const text = s.render(level);

    return { id: s.id, title: s.title, tokens: estimateTokens(text), level, text };
  });
}

function sum(report: readonly SectionReport[]): number {
  return report.reduce((n, s) => n + s.tokens, 0);
}

export function sizingOf(tokens: number, limits: Limits): Sizing {
  if (tokens >= limits.ctxFailTokens) {
    return 'fail';
  }

  if (tokens >= limits.ctxWarnTokens) {
    return 'warn';
  }

  if (tokens >= limits.ctxLargeTokens) {
    return 'large';
  }

  return 'ok';
}

function verdictLine(input: FooterInput, totals: Totals): string {
  const { limits } = input;
  const sizing = sizingOf(totals.full, limits);

  if (input.budget === null) {
    return `tokens: ${totals.printed} printed, full ${totals.full} (${sizing}); tiers large ≥ ${limits.ctxLargeTokens}, warn ≥ ${limits.ctxWarnTokens}, fail ≥ ${limits.ctxFailTokens}`;
  }

  const budget = input.budget === 0 ? 'none' : input.budget;

  return `budget: ${budget} (${totals.printed} tokens printed, full ${totals.full} (${sizing}); caps skipped)`;
}

function leftOutLine(include: readonly Include[]): string[] {
  const missing = INCLUDES.filter((name) => !include.includes(name));

  return missing.length === 0
    ? []
    : [`- not printed: ${missing.join(', ')} (\`--with ${missing.join(',')}\`)`];
}

function footerText(input: FooterInput, report: readonly SectionReport[], totals: Totals): string {
  const rows = report.map((s) => [s.id, String(s.tokens), String(s.level)]);
  const shrunk = report.filter((s) => s.level > 0).map((s) => `${s.id} (level ${s.level})`);
  const reproduce = ctxCommand(input.id, input);

  return [
    HEADINGS.footer,
    '',
    table(['section', 'tokens', 'level'], rows),
    '',
    `- ${verdictLine(input, totals)}`,
    `- truncated: ${shrunk.length === 0 ? 'nothing' : shrunk.join(', ')}`,
    ...leftOutLine(input.include),
    ...(input.error === null ? [] : [`- import error: ${input.error}`]),
    `- reproduce: \`${reproduce}\``,
  ].join('\n');
}

function briefTokens(body: readonly SectionReport[], footer: Footer): Brief {
  const base = sum(body);
  let tokens = base;
  let text = footer(body, tokens);

  for (let round = 0; round < FIXED_POINT_ROUNDS; round++) {
    const next = base + estimateTokens(text);
    if (next === tokens) {
      break;
    }

    tokens = next;
    text = footer(body, tokens);
  }

  return { tokens, footer: text };
}

function measure(sections: readonly Section[], levels: ReadonlyMap<string, Level>, footer: Footer): number {
  return briefTokens(reportOf(sections, levels), footer).tokens;
}

function shrink(sections: readonly Section[], budget: number, footer: Footer): Map<string, Level> {
  const levels = new Map<string, Level>(sections.map((s) => [s.id, 0]));
  for (const priority of SHRINK_ORDER) {
    for (const level of [1, 2] as const) {
      if (budget === 0 || measure(sections, levels, footer) <= budget) {
        return levels;
      }

      for (const section of sections.filter((s) => s.priority === priority)) {
        levels.set(section.id, level);
      }
    }
  }

  return levels;
}

function briefCatalog(catalog: Catalog, id: string, regeneration: Regeneration | null): Catalog {
  if (regeneration === null) {
    return catalog;
  }

  const { lanes } = regeneration;

  return withLanes(catalog, id, {
    needs: lanes.needs.values,
    listens: lanes.listens.values,
    emits: lanes.emits.values,
    requests: lanes.requests.values,
    serves: lanes.serves.values,
  });
}

function regenerationReport(regeneration: Regeneration | null): RegenerationReport | null {
  return regeneration === null ? null : { reason: regeneration.reason, lanes: regeneration.lanes };
}

function normalised(include: readonly Include[] | undefined): Include[] {
  const given = new Set(include ?? []);

  return INCLUDES.filter((name) => given.has(name));
}

function briefSections(analysis: Analysis, subject: ContextSubject, include: Includes): Section[] {
  const catalog = briefCatalog(analysis.catalog, subject.id, subject.regeneration);

  return withStorage(bodySections(subject, catalog, include), ownedStorage(analysis, subject.node));
}

function fullTokensOf(analysis: Analysis, subject: ContextSubject, input: FooterInput): number {
  const full = input.withholdCode ? contextSubject(analysis, subject.node, { withholdCode: false }) : subject;
  const report = reportOf(briefSections(analysis, full, new Set(INCLUDES)), new Map());
  const fullInput: FooterInput = { ...input, budget: null, withholdCode: false, include: [...INCLUDES] };

  return briefTokens(report, (body, total) => footerText(fullInput, body, { printed: total, full: total }))
    .tokens;
}

export function assembleContext(analysis: Analysis, id: string, options: ContextOptions): ContextResult {
  const node = analysis.repo.folders.get(id);
  if (node === undefined || id === '') {
    throw new Error(`no piece or folder ${id} under pieces/`);
  }

  const withholdCode = options.withholdCode ?? false;
  const include = normalised(options.include);
  const subject = contextSubject(analysis, node, { withholdCode });
  const { limits } = analysis.description;
  const error = subject.info?.error ?? null;
  const sections = briefSections(analysis, subject, new Set(include));
  const input: FooterInput = { id, budget: options.budget, withholdCode, include, limits, error };
  const full = fullTokensOf(analysis, subject, input);
  const footer: Footer = (report, printed) => footerText(input, report, { printed, full });
  const levels =
    options.budget === null ? new Map<string, Level>() : shrink(sections, options.budget, footer);
  const body = reportOf(sections, levels);
  const brief = briefTokens(body, footer);
  const report = [...body, { id: 'footer', title: 'Footer', ...measured(brief.footer) }];
  const budget = options.budget;

  return {
    piece: id,
    markdown: report
      .map((s) => s.text)
      .filter((t) => t !== '')
      .join('\n\n'),
    sections: report,
    tokens: brief.tokens,
    fullTokens: full,
    budget,
    overBudget: budget !== null && budget !== 0 && brief.tokens > budget,
    sizing: sizingOf(full, limits),
    limits: {
      ctxLargeTokens: limits.ctxLargeTokens,
      ctxWarnTokens: limits.ctxWarnTokens,
      ctxFailTokens: limits.ctxFailTokens,
    },
    error,
    regeneration: regenerationReport(subject.regeneration),
  };
}

function measured(text: string): Pick<SectionReport, 'text' | 'tokens' | 'level'> {
  return { text, tokens: estimateTokens(text), level: 0 };
}
