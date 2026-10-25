import { describe, expect, test } from 'vitest';

import { buildGraph } from '../graph/edges.ts';
import { layoutGraph, type LayoutInput } from '../graph/layout.ts';
import { todoSnapshot, present } from './fixtures.ts';

function input(expanded: string[] = []): LayoutInput {
  const snapshot = todoSnapshot();

  return {
    pieces: snapshot.pieces,
    contracts: snapshot.contracts,
    capabilities: snapshot.capabilities,
    warnings: snapshot.warnings,
    expanded: new Set(expanded),
  };
}

function positions(expanded: string[] = []) {
  return layoutGraph(input(expanded)).nodes.map((n) => [
    n.id,
    n.kind,
    n.layer,
    n.x,
    Math.round(n.y * 1000) / 1000,
  ]);
}

describe('graph model', () => {
  test('groups collapse to one node by default with a child count and aggregated public edges', () => {
    const graph = buildGraph(input());
    const ids = graph.nodes.map((n) => n.id);
    expect(ids).toEqual(['ingress:http', 'audit', 'stats', 'todos', 'ghost:audit.recorded', '$dead-letter']);
    expect(graph.nodes.find((n) => n.id === 'todos')).toMatchObject({ kind: 'group', childCount: 3 });
    expect(graph.edges.map((e) => `${e.from} -${e.contract}-> ${e.to}`)).toEqual([
      'ingress:http -http-> todos',
      'todos -todo.created-> audit',
      'todos -todo.created-> stats',
      'audit -audit.recorded-> ghost:audit.recorded',
    ]);
    expect(graph.edges.some((e) => e.internal)).toBe(false);
  });

  test('expanding a group shows its children and its internal contracts dashed', () => {
    const graph = buildGraph(input(['todos', 'audit', 'stats']));
    expect(graph.nodes.filter((n) => n.kind === 'piece').map((n) => [n.id, n.group])).toEqual([
      ['audit/record', 'audit'],
      ['stats/count', 'stats'],
      ['todos/create', 'todos'],
      ['todos/list', 'todos'],
      ['todos/notify', 'todos'],
    ]);
    const internal = graph.edges.filter((e) => e.internal);
    expect(internal.map((e) => `${e.from}->${e.to}`)).toEqual(['todos/create->todos/notify']);
    expect(graph.edges.find((e) => e.contract === 'audit.recorded')).toMatchObject({ warning: true });
  });
});

describe('layered layout', () => {
  test('is deterministic for a fixed snapshot', () => {
    expect(positions()).toEqual(positions());
    expect(positions(['todos'])).toEqual(positions(['todos']));
  });

  test('layer = longest path from ingress, ingress left, dead-letter sink right', () => {
    const nodes = layoutGraph(input()).nodes;
    const layer = Object.fromEntries(nodes.map((n) => [n.id, n.layer]));
    expect(layer).toEqual({
      'ingress:http': 0,
      todos: 1,
      stats: 2,
      audit: 2,
      'ghost:audit.recorded': 3,
      '$dead-letter': 4,
    });
    const x = Object.fromEntries(nodes.map((n) => [n.id, n.x]));
    expect(x['ingress:http']).toBeLessThan(present(x['todos']));
    expect(x['$dead-letter']).toBeGreaterThan(present(x['ghost:audit.recorded']));
  });

  test('nodes in one layer do not overlap after de-overlap', () => {
    const nodes = layoutGraph(input(['todos', 'audit', 'stats'])).nodes;
    const byLayer = Map.groupBy(nodes, (n) => n.layer);

    for (const group of byLayer.values()) {
      const ys = group.map((n) => n.y).toSorted((a, b) => a - b);
      for (let i = 1; i < ys.length; i++) {
        expect(present(ys[i]) - present(ys[i - 1])).toBeGreaterThanOrEqual(60);
      }
    }
  });

  test('collapsed and expanded layouts differ but each is stable', () => {
    expect(positions(['todos'])).not.toEqual(positions());
    const expanded = layoutGraph(input(['todos'])).nodes;
    expect(expanded.find((n) => n.id === 'todos/notify')?.layer).toBe(2);
  });

  test('pinned positions override the computed ones', () => {
    const nodes = layoutGraph({ ...input(), pinned: { stats: { x: 5, y: 7 } } }).nodes;
    expect(nodes.find((n) => n.id === 'stats')).toMatchObject({ x: 5, y: 7 });
  });
});
