import { relative } from 'node:path';

import type { Analysis } from '../analysis/analyze.ts';
import { finding, type Finding } from './finding.ts';
import { folderFileFindings } from './folder-files.ts';
import { tableWriteFindings } from './table-writes.ts';

function pieceFindings(analysis: Analysis): Finding[] {
  const { root } = analysis.repo;

  return analysis.statics.findings.map((f) =>
    finding(f.rule, f.severity, relative(root, f.file), f.message, { line: f.line, col: f.col }),
  );
}

function routeFindings(analysis: Analysis): Finding[] {
  const { root } = analysis.repo;

  return analysis.statics.routes.problems.map((p) =>
    finding(p.code, p.severity, relative(root, p.file), p.message, { line: p.line, pieces: p.pieces }),
  );
}

export function staticFindings(analysis: Analysis): Finding[] {
  return [
    ...pieceFindings(analysis),
    ...routeFindings(analysis),
    ...folderFileFindings(analysis),
    ...tableWriteFindings(analysis),
  ];
}
