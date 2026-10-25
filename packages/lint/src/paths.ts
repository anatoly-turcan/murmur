import { existsSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';

export function isInside(dir: string, path: string): boolean {
  return path === dir || path.startsWith(dir + sep);
}

export function piecesRoot(filename: string): string | undefined {
  const dirs = dirname(filename).split(sep);
  const at = dirs.lastIndexOf('pieces');

  if (at <= 0) {
    return undefined;
  }

  return dirs.slice(0, at + 1).join(sep);
}

export function isPieceFile(filename: string): boolean {
  return /\.[cm]?tsx?$/.test(filename) && piecesRoot(filename) !== undefined;
}

export function isTestFile(filename: string): boolean {
  return /\.test\.[cm]?tsx?$/.test(filename);
}

export function isPieceEntry(filename: string): boolean {
  return basename(filename) === 'piece.ts' && isPieceFile(filename);
}

export function isGroupContracts(filename: string): boolean {
  const pieces = piecesRoot(filename);

  return pieces !== undefined && basename(filename) === 'contracts.ts' && dirname(filename) !== pieces;
}

export function isCoreFile(filename: string): boolean {
  return filename.split(sep).join('/').includes('/packages/core/src/');
}

export function hasPieceEntry(dir: string): boolean {
  return existsSync(join(dir, 'piece.ts'));
}

export function pieceDir(filename: string): string | undefined {
  const pieces = piecesRoot(filename);
  if (!pieces) {
    return undefined;
  }

  if (basename(filename) === 'piece.ts') {
    return dirname(filename);
  }

  for (let dir = dirname(filename); dir !== pieces && isInside(pieces, dir); dir = dirname(dir)) {
    if (hasPieceEntry(dir)) {
      return dir;
    }
  }

  return undefined;
}

export function pieceId(dir: string): string {
  return relative(piecesRoot(join(dir, 'piece.ts')) ?? dir, dir)
    .split(sep)
    .join('/');
}
