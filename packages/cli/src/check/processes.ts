import { join } from 'node:path';

import type { Analysis } from '../analysis/analyze.ts';
import { crossingMessage, crossings, emptyProcesses } from '../analysis/processes.ts';
import { finding, type Finding } from './finding.ts';

function pieceFile(analysis: Analysis, id: string): string {
  const dir = analysis.catalog.pieces.find((piece) => piece.name === id)?.dir ?? join('pieces', id);

  return join(dir, 'piece.ts');
}

function emptyProcessFindings(analysis: Analysis): Finding[] {
  return emptyProcesses(analysis).map((message) =>
    finding('process-invalid', 'error', 'murmur.config.ts', message),
  );
}

export function processFindings(analysis: Analysis): Finding[] {
  const crossed = crossings(analysis).map((crossing) =>
    finding(
      crossing.kind === 'request' ? 'request-crosses-process' : 'event-crosses-process',
      crossing.kind === 'request' ? 'error' : 'warn',
      pieceFile(analysis, crossing.piece),
      crossingMessage(crossing),
      { pieces: [crossing.piece] },
    ),
  );

  return [...emptyProcessFindings(analysis), ...crossed];
}
