import { join, relative } from 'node:path';

import type { Analysis } from '../analysis/analyze.ts';
import { docRef } from '../analysis/docs.ts';
import { readSource } from '../analysis/source-checks.ts';
import type { FolderNode, PieceInfo } from '../analysis/types.ts';
import { finding, type Finding } from './finding.ts';

export function lineCount(text: string): number {
  if (text === '') {
    return 0;
  }

  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

function sourceLines(node: FolderNode): number {
  return node.files
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.startsWith('fixtures/'))
    .reduce((n, f) => n + lineCount(readSource(join(node.dir, f)) ?? ''), 0);
}

export function sizingFindings(analysis: Analysis, node: FolderNode, info: PieceInfo | undefined): Finding[] {
  const { limits } = analysis.description;
  const pieceFile = relative(analysis.repo.root, node.pieceFile as string);
  const doc = docRef('piece-authoring', analysis.repo.root);
  const help = { help: `split by the five heuristics in ${doc}` };
  const found: Finding[] = [];
  const lines = sourceLines(node);

  if (lines > limits.pieceLines) {
    const message = `${node.id} has ${lines} source lines (cap ${limits.pieceLines}); see ${doc}`;
    found.push(finding('piece-too-long', 'warn', pieceFile, message, help));
  }

  const handlers = (info?.handlers.length ?? 0) + (info?.serves?.length ?? 0) + (info?.unresolvedServes ?? 0);
  if (handlers > limits.handlers) {
    const message = `${node.id} has ${handlers} handlers (cap ${limits.handlers}); see ${doc}`;
    found.push(finding('too-many-handlers', 'warn', pieceFile, message, help));
  }

  const context = node.contextFile === null ? 0 : lineCount(readSource(node.contextFile) ?? '');
  if (context > limits.contextLines) {
    const message = `${node.id}/context.md has ${context} lines (cap ${limits.contextLines}); see ${doc}`;
    const file = relative(analysis.repo.root, node.contextFile as string);
    found.push(finding('context-too-long', 'warn', file, message, help));
  }

  return found;
}
