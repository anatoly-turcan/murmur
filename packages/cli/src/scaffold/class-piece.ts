import { contextFile } from './class-piece-context.ts';
import type { ClassPiecePlan } from './class-piece-model.ts';
import { pieceFile, schemaFiles } from './class-piece-source.ts';
import { fixtureFiles, testFile } from './class-piece-test.ts';
import type { PlannedFile } from './piece.ts';

export function planClassPieceFiles(plan: ClassPiecePlan): PlannedFile[] {
  return [contextFile(plan), pieceFile(plan), testFile(plan), ...fixtureFiles(plan), ...schemaFiles(plan)];
}
