import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { parseFrontmatter } from './frontmatter.ts';
import type { ContractFile, FolderNode, Repo } from './types.ts';

const PIECES = 'pieces';

interface Walk {
  readonly piecesRoot: string;
  readonly pieceDirs: ReadonlySet<string>;
  readonly markerDirs: ReadonlySet<string>;
  readonly folders: Map<string, FolderNode>;
}

interface Found {
  readonly pieceDirs: Set<string>;
  readonly markerDirs: Set<string>;
}

function isSkipped(name: string): boolean {
  return name === 'node_modules' || name.startsWith('.');
}

function entries(dir: string): { dirs: string[]; files: string[] } {
  const all = readdirSync(dir, { withFileTypes: true }).filter((e) => !isSkipped(e.name));

  return {
    dirs: all
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .toSorted(),
    files: all
      .filter((e) => e.isFile())
      .map((e) => e.name)
      .toSorted(),
  };
}

function isMarker(file: string): boolean {
  return file === 'context.md' || file.endsWith('.test.ts');
}

function findDirs(dir: string, found: Found): Found {
  const { dirs, files } = entries(dir);
  if (files.includes('piece.ts')) {
    found.pieceDirs.add(dir);
  }

  if (files.some(isMarker)) {
    found.markerDirs.add(dir);
  }

  for (const name of dirs) {
    findDirs(join(dir, name), found);
  }

  return found;
}

function containsAny(dirs: ReadonlySet<string>, dir: string): boolean {
  const prefix = dir + sep;

  return [...dirs].some((d) => d.startsWith(prefix));
}

function idOf(piecesRoot: string, dir: string): string {
  return relative(piecesRoot, dir).split(sep).join('/');
}

function insidePiece(walk: Walk, dir: string): boolean {
  let current = dir;
  while (current !== walk.piecesRoot) {
    current = current.slice(0, current.lastIndexOf(sep));

    if (walk.pieceDirs.has(current)) {
      return true;
    }
  }

  return false;
}

function isNode(walk: Walk, dir: string): boolean {
  if (dir === walk.piecesRoot || walk.pieceDirs.has(dir)) {
    return true;
  }

  if (containsAny(walk.pieceDirs, dir)) {
    return true;
  }

  if (insidePiece(walk, dir)) {
    return false;
  }

  return walk.markerDirs.has(dir) || containsAny(walk.markerDirs, dir);
}

function ownFiles(walk: Walk, dir: string, base = dir): string[] {
  const { dirs, files } = entries(dir);
  const nested = dirs
    .map((name) => join(dir, name))
    .filter((child) => !isNode(walk, child))
    .flatMap((child) => ownFiles(walk, child, base));

  return [...files.map((name) => relative(base, join(dir, name)).split(sep).join('/')), ...nested];
}

function parentOf(id: string): string | null {
  if (id === '') {
    return null;
  }

  const cut = id.lastIndexOf('/');

  return cut === -1 ? '' : id.slice(0, cut);
}

function folderNode(walk: Walk, dir: string, children: string[]): FolderNode {
  const id = idOf(walk.piecesRoot, dir);
  const contextFile = existsSync(join(dir, 'context.md')) ? join(dir, 'context.md') : null;
  const front = contextFile === null ? null : parseFrontmatter(readFileSync(contextFile, 'utf8'));
  const segments = id === '' ? [PIECES] : id.split('/');
  const isPiece = walk.pieceDirs.has(dir);

  return {
    id,
    dir,
    kind: isPiece ? 'piece' : 'group',
    pieceFile: isPiece ? join(dir, 'piece.ts') : null,
    contextFile,
    title: front?.title ?? segments.at(-1) ?? id,
    summary: front?.summary ?? null,
    frontmatterError: front?.error ?? null,
    hasFrontmatter: front?.present ?? false,
    files: ownFiles(walk, dir),
    children,
    parent: parentOf(id),
    depth: id === '' ? 0 : segments.length,
  };
}

function walkFolders(walk: Walk, dir: string): void {
  const childDirs = entries(dir)
    .dirs.map((name) => join(dir, name))
    .filter((child) => isNode(walk, child));

  for (const child of childDirs) {
    walkFolders(walk, child);
  }

  const node = folderNode(
    walk,
    dir,
    childDirs.map((child) => idOf(walk.piecesRoot, child)),
  );
  walk.folders.set(node.id, node);
}

function contractSourcesIn(dir: string): string[] {
  const { dirs, files } = entries(dir);
  const own = files
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => join(dir, name));

  return [...own, ...dirs.flatMap((name) => contractSourcesIn(join(dir, name)))];
}

function contractFiles(root: string, folders: ReadonlyMap<string, FolderNode>): ContractFile[] {
  const contractsDir = join(root, 'contracts');
  const publicFiles = existsSync(contractsDir)
    ? contractSourcesIn(contractsDir).map((file) => ({ file, visibility: 'public' as const, scope: null }))
    : [];
  const internalFiles = [...folders.values()]
    .filter((node) => node.files.includes('contracts.ts'))
    .map((node) => ({
      file: join(node.dir, 'contracts.ts'),
      visibility: 'internal' as const,
      scope: node.id,
    }));

  return [...publicFiles, ...internalFiles.toSorted((a, b) => a.file.localeCompare(b.file))];
}

function capabilityFiles(root: string): string[] {
  const dir = join(root, 'capabilities');
  if (!existsSync(dir)) {
    return [];
  }

  return entries(dir)
    .dirs.map((name) => join(dir, name, 'capability.ts'))
    .filter((file) => existsSync(file));
}

export function discover(root: string): Repo {
  const piecesRoot = join(root, PIECES);
  const folders = new Map<string, FolderNode>();

  if (existsSync(piecesRoot)) {
    const found = findDirs(piecesRoot, { pieceDirs: new Set(), markerDirs: new Set() });
    walkFolders({ piecesRoot, ...found, folders }, piecesRoot);
  }

  const sorted = new Map([...folders.entries()].toSorted(([a], [b]) => a.localeCompare(b)));

  return {
    root,
    piecesDir: piecesRoot,
    folders: sorted,
    contractFiles: contractFiles(root, sorted),
    capabilityFiles: capabilityFiles(root),
  };
}

export function pieceNodes(repo: Repo): FolderNode[] {
  return [...repo.folders.values()].filter((node) => node.kind === 'piece');
}

export function isRegenerationLeaf(node: FolderNode): boolean {
  if (node.kind === 'piece' || node.id === '' || node.children.length > 0) {
    return false;
  }

  return node.contextFile !== null || node.files.some((f) => f.endsWith('.test.ts'));
}

export function isWithin(id: string, scope: string): boolean {
  return scope === '' || id === scope || id.startsWith(`${scope}/`);
}
