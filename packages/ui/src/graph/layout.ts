import { forceCollide, forceSimulation, forceY, type SimulationNodeDatum } from 'd3-force';

import { compareIds } from '../store/tree.ts';
import {
  buildGraph,
  DEAD_LETTER,
  servesRoutes,
  type GraphEdge,
  type GraphInput,
  type GraphNode,
} from './edges.ts';

export const LAYER_WIDTH = 240;
export const ROW_HEIGHT = 90;
const COLLIDE_RADIUS = 36;
const ITERATIONS = 300;
const SEED = 0x6d75726d;

export interface Point {
  x: number;
  y: number;
}

export interface LayoutInput extends GraphInput {
  pinned?: Record<string, Point>;
}

export interface PlacedNode extends GraphNode, Point {
  layer: number;
}

export interface Layout {
  nodes: PlacedNode[];
  edges: GraphEdge[];
  width: number;
  height: number;
}

function seeded(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;

    return state / 2 ** 32;
  };
}

function successors(nodes: GraphNode[], edges: GraphEdge[]): Map<string, string[]> {
  const next = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  for (const e of edges) {
    next.get(e.from)?.push(e.to);
  }

  return next;
}

function topoOrder(nodes: GraphNode[], next: Map<string, string[]>): { order: string[]; back: Set<string> } {
  const state = new Map<string, 'open' | 'done'>();
  const order: string[] = [];
  const back = new Set<string>();
  const visit = (id: string): void => {
    state.set(id, 'open');

    for (const to of next.get(id) ?? []) {
      if (state.get(to) === 'open') {
        back.add(`${id}>${to}`);
      } else if (!state.has(to)) {
        visit(to);
      }
    }

    state.set(id, 'done');
    order.push(id);
  };
  const starts = [...nodes.filter((n) => n.kind === 'ingress'), ...nodes];

  for (const n of starts) {
    if (!state.has(n.id)) {
      visit(n.id);
    }
  }

  return { order: order.toReversed(), back };
}

function isEdgeUnit(node: GraphNode): boolean {
  return servesRoutes(node.pieceKind);
}

function startLayer(node: GraphNode, base: number, edgeColumn: boolean): number {
  if (node.kind === 'ingress') {
    return 0;
  }

  if (edgeColumn && !isEdgeUnit(node)) {
    return base + 1;
  }

  return base;
}

export function assignLayers(nodes: GraphNode[], edges: GraphEdge[]): Map<string, number> {
  const graphNodes = nodes.filter((n) => n.id !== DEAD_LETTER);
  const next = successors(graphNodes, edges);
  const { order, back } = topoOrder(graphNodes, next);
  const base = graphNodes.some((n) => n.kind === 'ingress') ? 1 : 0;
  const edgeColumn = graphNodes.some(isEdgeUnit);
  const layer = new Map(graphNodes.map((n) => [n.id, startLayer(n, base, edgeColumn)]));
  const edgeUnits = new Set(graphNodes.filter(isEdgeUnit).map((n) => n.id));

  for (const id of order) {
    for (const to of next.get(id) ?? []) {
      if (back.has(`${id}>${to}`) || edgeUnits.has(to)) {
        continue;
      }

      layer.set(to, Math.max(layer.get(to) ?? 0, (layer.get(id) ?? 0) + 1));
    }
  }

  layer.set(DEAD_LETTER, Math.max(0, ...layer.values()) + 1);

  return layer;
}

function byGroupThenId(a: GraphNode, b: GraphNode): number {
  const ga = a.group ?? '';
  const gb = b.group ?? '';

  if (ga !== gb) {
    return ga < gb ? -1 : 1;
  }

  return compareIds(a, b);
}

function initialPlacement(nodes: GraphNode[], layers: Map<string, number>): PlacedNode[] {
  const columns = Map.groupBy(nodes, (n) => layers.get(n.id) ?? 0);
  const tallest = Math.max(1, ...[...columns.values()].map((c) => c.length));

  return [...columns.entries()]
    .toSorted(([a], [b]) => a - b)
    .flatMap(([layer, column]) => {
      const offset = ((tallest - column.length) * ROW_HEIGHT) / 2;

      return column
        .toSorted(byGroupThenId)
        .map((n, i) => ({ ...n, layer, x: layer * LAYER_WIDTH, y: offset + i * ROW_HEIGHT }));
    });
}

interface SimNode extends SimulationNodeDatum {
  id: string;
  targetY: number;
}

function deOverlap(placed: PlacedNode[]): Map<string, number> {
  const sim: SimNode[] = placed.map((n) => ({ id: n.id, x: n.x, y: n.y, fx: n.x, targetY: n.y }));
  const simulation = forceSimulation(sim)
    .randomSource(seeded(SEED))
    .force('y', forceY<SimNode>((n) => n.targetY).strength(0.2))
    .force('collide', forceCollide<SimNode>(COLLIDE_RADIUS))
    .stop();
  simulation.tick(ITERATIONS);

  return new Map(sim.map((n) => [n.id, Math.round((n.y ?? 0) * 1000) / 1000]));
}

export function layoutGraph(input: LayoutInput): Layout {
  const model = buildGraph(input);
  const placed = initialPlacement(model.nodes, assignLayers(model.nodes, model.edges));
  const ys = deOverlap(placed);
  const nodes = placed.map((n) => ({ ...n, y: ys.get(n.id) ?? n.y, ...input.pinned?.[n.id] }));

  return {
    nodes,
    edges: model.edges,
    width: Math.max(0, ...nodes.map((n) => n.x)) + LAYER_WIDTH,
    height: Math.max(0, ...nodes.map((n) => n.y)) + ROW_HEIGHT,
  };
}
