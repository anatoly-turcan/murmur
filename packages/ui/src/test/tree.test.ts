import type { TreeNode } from '@murmur/dev-protocol';
import { describe, expect, test } from 'vitest';

import { ancestors, buildTree, findNode, flattenVisible, subtreePieces } from '../store/tree.ts';
import { pieceView } from './fixtures.ts';

function shape(nodes: TreeNode[]): unknown[] {
  return nodes.map((n) => [n.id, n.kind, ...(n.children.length ? [shape(n.children)] : [])]);
}

describe('tree builder', () => {
  const pieces = [
    pieceView('todos/list'),
    pieceView('billing/sim/rates', { title: 'Rates', summary: 'rate tables' }),
    pieceView('todos/create'),
    pieceView('billing'),
    pieceView('audit'),
    pieceView('billing/invoice'),
  ];

  test('turns PieceView[] into the folder tree with implied groups, sorted by path', () => {
    expect(shape(buildTree(pieces))).toEqual([
      ['audit', 'piece'],
      [
        'billing',
        'piece',
        [
          ['billing/invoice', 'piece'],
          ['billing/sim', 'group', [['billing/sim/rates', 'piece']]],
        ],
      ],
      [
        'todos',
        'group',
        [
          ['todos/create', 'piece'],
          ['todos/list', 'piece'],
        ],
      ],
    ]);
  });

  test('pieces carry title/summary, implied groups default to the last segment', () => {
    const tree = buildTree(pieces);
    const rates = findNode(tree, 'billing/sim/rates');
    expect(rates).toMatchObject({ title: 'Rates', summary: 'rate tables' });
    expect(findNode(tree, 'todos')).toMatchObject({ kind: 'group', title: 'todos', summary: null });
  });

  test('server group metadata fills group titles and summaries', () => {
    const groups: TreeNode[] = [
      { id: 'todos', kind: 'group', title: 'Todos', summary: 'todo domain', children: [] },
    ];
    expect(findNode(buildTree(pieces, groups), 'todos')).toMatchObject({
      title: 'Todos',
      summary: 'todo domain',
    });
  });

  test('empty input gives an empty tree', () => {
    expect(buildTree([])).toEqual([]);
  });

  test('helpers: ancestors, subtree pieces, visible flattening by expansion', () => {
    const tree = buildTree(pieces);
    expect(ancestors('billing/sim/rates')).toEqual(['billing', 'billing/sim']);
    expect(subtreePieces(tree, 'billing')).toEqual(['billing', 'billing/invoice', 'billing/sim/rates']);
    expect(flattenVisible(tree, new Set()).map((n) => n.id)).toEqual(['audit', 'billing', 'todos']);
    expect(flattenVisible(tree, new Set(['billing'])).map((n) => n.id)).toEqual([
      'audit',
      'billing',
      'billing/invoice',
      'billing/sim',
      'todos',
    ]);
  });
});
