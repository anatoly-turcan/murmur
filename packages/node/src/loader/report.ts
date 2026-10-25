import { MurmurError, type SchemaIssue } from 'murmur';

import type { BootError, BootReport, BootReportPiece, BootWarning, Catalog } from '../types.ts';
import type { PieceCandidate } from './candidate.ts';

export class BootFailedError extends MurmurError {
  override readonly name: string = 'BootFailedError';
  readonly report: BootReport;

  constructor(report: BootReport) {
    super(formatReport(report), { code: 'boot-failed', retryable: false });
    this.report = report;
  }
}

export function buildReport(
  candidates: readonly PieceCandidate[],
  appErrors: readonly BootError[],
  appWarnings: readonly BootWarning[],
  catalog: Catalog,
): BootReport {
  const pieces: BootReportPiece[] = candidates.map((c) => ({
    name: c.id,
    file: c.file,
    errors: c.errors,
    warnings: c.warnings,
  }));
  const errors = [...appErrors, ...candidates.flatMap((c) => c.errors)];
  const warnings = [...appWarnings, ...candidates.flatMap((c) => c.warnings)];

  return { ok: errors.length === 0, pieces, errors, warnings, catalog };
}

function withPieceErrors(piece: BootReportPiece, errors: readonly BootError[]): BootReportPiece {
  const own = errors.filter((error) => error.piece === piece.name);

  return { ...piece, errors: [...piece.errors, ...own] };
}

export function reportWith(report: BootReport, errors: readonly BootError[]): BootReport {
  return {
    ...report,
    ok: report.ok && errors.length === 0,
    errors: [...report.errors, ...errors],
    pieces: report.pieces.map((piece) => withPieceErrors(piece, errors)),
  };
}

function issueLine(issue: SchemaIssue): string {
  const path = (issue.path ?? []).map(String).join('.');

  return `      ${path === '' ? '(root)' : path}: ${issue.message}`;
}

function errorLines(error: BootError): string[] {
  const code = error.code === undefined ? '' : ` [${error.code}]`;

  return [`    ${error.phase}${code}: ${error.message}`, ...(error.issues ?? []).map(issueLine)];
}

function summary(report: BootReport): string {
  const failing = report.pieces.filter((p) => p.errors.length > 0).length;
  const state = report.ok ? 'boot ok' : 'boot failed';

  return `${state}: ${report.errors.length} errors in ${failing} pieces, ${report.warnings.length} warnings`;
}

function human(report: BootReport): string {
  const shared = report.errors.filter((e) => !report.pieces.some((p) => p.errors.includes(e)));
  const pieceBlocks = report.pieces.flatMap((p) =>
    p.errors.length === 0 ? [] : [`  ${p.name}  ${p.file}`, ...p.errors.flatMap(errorLines)],
  );
  const appBlock = shared.length === 0 ? [] : ['  app', ...shared.flatMap(errorLines)];
  const warnings = report.warnings.map((w) => `  warn ${w.code}: ${w.message}`);

  return [summary(report), ...appBlock, ...pieceBlocks, ...warnings].join('\n');
}

export function formatReport(report: BootReport, format: 'human' | 'json' = 'human'): string {
  return format === 'json' ? JSON.stringify(report, null, 2) : human(report);
}
