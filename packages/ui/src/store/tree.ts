import type { PieceView, TreeNode } from '@murmur/dev-protocol';

interface MutableNode {
  id: string;
  kind: 'group' | 'piece';
  title: string;
  summary: string | null;
  children: Map<string, MutableNode>;
}

function lastSegment(id: string): string {
  return id.slice(id.lastIndexOf('/') + 1);
}

export function ancestors(id: string): string[] {
  const segments = id.split('/');

  return segments.slice(0, -1).map((_, i) => segments.slice(0, i + 1).join('/'));
}

function indexGroups(groups: TreeNode[], into = new Map<string, TreeNode>()): Map<string, TreeNode> {
  for (const node of groups) {
    into.set(node.id, node);
    indexGroups(node.children, into);
  }

  return into;
}

function groupNode(id: string, known: Map<string, TreeNode>): MutableNode {
  const meta = known.get(id);

  return {
    id,
    kind: 'group',
    title: meta?.title ?? lastSegment(id),
    summary: meta?.summary ?? null,
    children: new Map(),
  };
}

function ensure(level: Map<string, MutableNode>, id: string, known: Map<string, TreeNode>): MutableNode {
  let node = level.get(id);
  if (!node) {
    node = groupNode(id, known);
    level.set(id, node);
  }

  return node;
}

function insert(roots: Map<string, MutableNode>, piece: PieceView, known: Map<string, TreeNode>): void {
  let level = roots;
  for (const id of ancestors(piece.name)) {
    level = ensure(level, id, known).children;
  }

  const node = ensure(level, piece.name, known);
  node.kind = 'piece';
  node.title = piece.title;
  node.summary = piece.summary;
}

function freeze(level: Map<string, MutableNode>): TreeNode[] {
  return [...level.values()].toSorted(compareIds).map((node) => ({
    id: node.id,
    kind: node.kind,
    title: node.title,
    summary: node.summary,
    children: freeze(node.children),
  }));
}

export function buildTree(pieces: PieceView[], groups: TreeNode[] = []): TreeNode[] {
  const known = indexGroups(groups);
  const roots = new Map<string, MutableNode>();

  for (const piece of pieces) {
    insert(roots, piece, known);
  }

  return freeze(roots);
}

export function findNode(nodes: TreeNode[], id: string): TreeNode | null {
  for (const node of nodes) {
    if (node.id === id) {
      return node;
    }

    if (id.startsWith(`${node.id}/`)) {
      return findNode(node.children, id);
    }
  }

  return null;
}

function collectPieces(node: TreeNode, into: string[]): string[] {
  if (node.kind === 'piece') {
    into.push(node.id);
  }

  for (const child of node.children) {
    collectPieces(child, into);
  }

  return into;
}

export function subtreePieces(nodes: TreeNode[], id: string): string[] {
  const node = findNode(nodes, id);

  return node ? collectPieces(node, []) : [];
}

export function flattenVisible(
  nodes: TreeNode[],
  expanded: ReadonlySet<string>,
  into: TreeNode[] = [],
): TreeNode[] {
  for (const node of nodes) {
    into.push(node);

    if (expanded.has(node.id)) {
      flattenVisible(node.children, expanded, into);
    }
  }

  return into;
}

export function inScope(id: string, scope: string | null): boolean {
  return !scope || id === scope || id.startsWith(`${scope}/`);
}

export function compareIds(a: { id: string }, b: { id: string }): number {
  if (a.id === b.id) {
    return 0;
  }

  return a.id < b.id ? -1 : 1;
}
