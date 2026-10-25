import { glob } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import { LoadError, type PieceClass } from 'murmur';

import { classPieceExport } from '../loader/class-piece.ts';
import { importFile, messageOf } from '../loader/import.ts';
import { pieceIdOf } from '../loader/piece-id.ts';

function piecesRootOf(dir: string): string {
  let current = dir;
  while (basename(current) !== 'pieces') {
    const parent = dirname(current);
    if (parent === current) {
      throw new LoadError(dir, 'load', 'loadSubtree expects a folder inside pieces/');
    }

    current = parent;
  }

  return current;
}

function classOf(id: string, file: string, module: Record<string, unknown>): PieceClass {
  const exported = classPieceExport(id, module);
  if (!exported.ok) {
    throw new LoadError(file, 'declaration', exported.message);
  }

  return exported.definition.pieceClass;
}

async function pieceClassOf(id: string, file: string): Promise<PieceClass> {
  const imported = await importFile(file);
  if (!imported.ok) {
    throw new LoadError(file, 'load', messageOf(imported.error), { cause: imported.error });
  }

  return classOf(id, file, imported.module);
}

export async function loadSubtree(dir: string): Promise<Record<string, PieceClass>> {
  const absolute = resolve(dir);
  const piecesRoot = piecesRootOf(absolute);

  const found = await Array.fromAsync(
    glob('**/piece.ts', { cwd: absolute, exclude: (path) => basename(path) === 'node_modules' }),
  );

  const files = found.map((path) => join(absolute, path));

  const entries = await Promise.all(
    files.map(async (file) => {
      const id = pieceIdOf(file, piecesRoot);

      return [id, await pieceClassOf(id, file)] as const;
    }),
  );

  return Object.fromEntries(entries.toSorted(([a], [b]) => a.localeCompare(b)));
}
