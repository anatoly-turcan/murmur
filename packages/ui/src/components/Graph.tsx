import { select } from 'd3-selection';
import { zoom, zoomIdentity, type ZoomBehavior } from 'd3-zoom';
import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type PointerEvent,
  type Ref,
  type RefObject,
  type ReactNode,
} from 'react';

import { edgePath, PULSE_MS } from '../graph/animate.ts';
import type { GraphEdge } from '../graph/edges.ts';
import type { Layout, PlacedNode, Point } from '../graph/layout.ts';
import { Sparkline } from './Sparkline.tsx';

export const NODE_W = 168;
export const NODE_H = 58;

export interface NodeLive {
  spark: number[];
  inflight: number;
  p95: number | null;
  failed: boolean;
  deadLettered: number;
}

export interface Pulse {
  key: number;
  edgeId: string;
}

export interface GraphHandle {
  reset: () => void;
  fit: () => void;
}

interface GraphProps {
  layout: Layout;
  live: (node: PlacedNode) => NodeLive;
  pulses: Pulse[];
  suppressed: (edgeId: string) => number;
  selected: string | null;
  dimmed: boolean;
  onNode: (node: PlacedNode) => void;
  onToggle: (node: PlacedNode) => void;
  onEdge: (edge: GraphEdge) => void;
  onDrag: (id: string, point: Point) => void;
  onClearDead: (node: PlacedNode) => void;
  handle?: Ref<GraphHandle>;
}

function anchor(node: PlacedNode, side: 'in' | 'out'): Point {
  if (node.kind === 'ingress' || node.kind === 'dlq') {
    return { x: node.x + (side === 'out' ? 24 : 0), y: node.y + NODE_H / 2 };
  }

  return { x: node.x + (side === 'out' ? NODE_W : 0), y: node.y + NODE_H / 2 };
}

function pathOf(edge: GraphEdge, nodes: Map<string, PlacedNode>): string | null {
  const from = nodes.get(edge.from);
  const to = nodes.get(edge.to);

  if (!from || !to) {
    return null;
  }

  const a = anchor(from, 'out');
  const b = anchor(to, 'in');

  return edgePath(a.x, a.y, b.x, b.y);
}

function EdgeView({
  edge,
  d,
  failed,
  onEdge,
  badge,
}: {
  edge: GraphEdge;
  d: string;
  failed: boolean;
  onEdge: () => void;
  badge: number;
}) {
  const tone = edgeTone(edge, failed);
  const dashed = edge.internal || edge.warning || edge.guard === true;

  return (
    <g className="cursor-pointer" onClick={onEdge} data-edge={edge.id}>
      <title>{edge.contract}</title>
      <path d={d} fill="none" strokeWidth={12} stroke="transparent" />
      <path
        d={d}
        fill="none"
        strokeWidth={1.25}
        className={tone}
        strokeDasharray={dashed ? '4 3' : undefined}
      />
      <text className="fill-ink-muted font-mono text-[10px]">
        <textPath href={`#edge-${edge.id}`} startOffset="50%">
          {edgeText(edge, badge)}
        </textPath>
      </text>
    </g>
  );
}

function edgeTone(edge: GraphEdge, failed: boolean): string {
  if (failed) {
    return 'stroke-fail';
  }

  return edge.warning ? 'stroke-warn' : 'stroke-ink-muted/60';
}

export function edgeText(edge: Pick<GraphEdge, 'badge' | 'label'>, suppressed: number): string {
  const name = edge.label === undefined ? '' : `${edge.badge ?? ''} ${edge.label}`.trim();
  const count = suppressed > 0 ? `×${suppressed}` : '';

  return [name, count].filter((part) => part !== '').join(' ');
}

function borderTone(failed: boolean, selected: boolean): string {
  if (failed) {
    return 'stroke-fail';
  }

  return selected ? 'stroke-accent' : 'stroke-line';
}

function NodeBody({ node, live, props }: { node: PlacedNode; live: NodeLive; props: GraphProps }) {
  if (node.kind === 'ingress') {
    return (
      <g>
        <polygon
          points={`12,${NODE_H / 2 - 12} 24,${NODE_H / 2} 12,${NODE_H / 2 + 12} 0,${NODE_H / 2}`}
          className="fill-accent/20 stroke-accent"
        />
        <text x={0} y={NODE_H / 2 + 26} className="fill-ink-muted font-mono text-[10px]">
          {node.label}
        </text>
      </g>
    );
  }

  if (node.kind === 'dlq') {
    return (
      <g>
        <circle cx={12} cy={NODE_H / 2} r={11} className="fill-fail/10 stroke-fail" />
        <text x={-12} y={NODE_H / 2 + 26} className="fill-ink-muted text-[10px]">
          dead letters
        </text>
      </g>
    );
  }

  const border = borderTone(live.failed, props.selected === node.id);
  const p95 = live.p95 === null ? '—' : `${Math.round(live.p95)}ms`;

  return (
    <g>
      <rect
        width={NODE_W}
        height={NODE_H}
        rx={6}
        className={`fill-paper ${border}`}
        strokeWidth={live.failed ? 2 : 1}
        strokeDasharray={node.kind === 'ghost' ? '4 3' : undefined}
      />
      {node.kind === 'group' ? (
        <g
          onClick={(e) => {
            e.stopPropagation();
            props.onToggle(node);
          }}
        >
          <rect x={NODE_W - 34} y={6} width={28} height={14} rx={7} className="fill-accent/15" />
          <text x={NODE_W - 20} y={16} textAnchor="middle" className="fill-accent font-mono text-[10px]">
            ▸{node.childCount}
          </text>
        </g>
      ) : null}
      <text x={8} y={17} className="fill-ink text-[12px] font-medium">
        {node.label}
      </text>
      {node.kind === 'ghost' ? null : (
        <>
          <foreignObject x={8} y={24} width={84} height={18}>
            <Sparkline values={live.spark} width={80} height={16} />
          </foreignObject>
          <text x={8} y={NODE_H - 6} className="fill-ink-muted font-mono text-[10px]">
            {live.inflight} inflight · p95 {p95}
          </text>
        </>
      )}
      {live.deadLettered > 0 ? (
        <g
          onClick={(e) => {
            e.stopPropagation();
            props.onClearDead(node);
          }}
        >
          <title>dead-lettered — click to clear</title>
          <circle cx={NODE_W} cy={0} r={9} className="fill-fail" />
          <text x={NODE_W} y={3} textAnchor="middle" className="fill-paper font-mono text-[9px]">
            {live.deadLettered}
          </text>
        </g>
      ) : null}
    </g>
  );
}

function useZoom(svg: RefObject<SVGSVGElement | null>, layout: Layout, handle: Ref<GraphHandle> | undefined) {
  const [transform, setTransform] = useState('');
  const behavior = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  useEffect(() => {
    if (!svg.current) {
      return;
    }

    const z = zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.2, 3])
      .filter((event: Event) => !(event.target as Element).closest?.('[data-node]') || event.type === 'wheel')
      .on('zoom', (event: { transform: { toString(): string } }) => setTransform(event.transform.toString()));
    behavior.current = z;
    select(svg.current).call(z);

    return () => {
      if (svg.current) {
        select(svg.current).on('.zoom', null);
      }
    };
  }, [svg]);
  useImperativeHandle(handle, () => ({
    reset: () =>
      svg.current && behavior.current?.transform(select(svg.current), zoomIdentity.translate(40, 40)),
    fit: () => {
      const el = svg.current;
      if (!el || !behavior.current) {
        return;
      }

      const k = Math.min(el.clientWidth / (layout.width + 80), el.clientHeight / (layout.height + 80), 1.5);
      behavior.current.transform(select(el), zoomIdentity.translate(40, 40).scale(k));
    },
  }));

  return transform || 'translate(40,40)';
}

function useDrag(onDrag: GraphProps['onDrag'], onNode: (node: PlacedNode) => void) {
  const drag = useRef<{ node: PlacedNode; start: Point; origin: Point; moved: boolean } | null>(null);

  return {
    down: (node: PlacedNode, e: PointerEvent) => {
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
      drag.current = {
        node,
        start: { x: e.clientX, y: e.clientY },
        origin: { x: node.x, y: node.y },
        moved: false,
      };
    },
    move: (e: PointerEvent) => {
      const d = drag.current;
      if (!d) {
        return;
      }

      const dx = e.clientX - d.start.x;
      const dy = e.clientY - d.start.y;

      if (Math.abs(dx) + Math.abs(dy) > 3) {
        d.moved = true;
      }

      if (d.moved) {
        onDrag(d.node.id, { x: d.origin.x + dx, y: d.origin.y + dy });
      }
    },
    up: () => {
      const d = drag.current;
      drag.current = null;

      if (d && !d.moved) {
        onNode(d.node);
      }
    },
  };
}

export function Graph(props: GraphProps): ReactNode {
  const svg = useRef<SVGSVGElement>(null);
  const transform = useZoom(svg, props.layout, props.handle);
  const nodes = new Map(props.layout.nodes.map((n) => [n.id, n]));
  const failedNodes = new Set(props.layout.nodes.filter((n) => props.live(n).failed).map((n) => n.id));
  const drag = useDrag(props.onDrag, props.onNode);
  const deadEdges: GraphEdge[] = props.layout.nodes
    .filter((n) => props.live(n).deadLettered > 0)
    .map((n) => ({
      id: `${n.id}|dead|$dead-letter`,
      from: n.id,
      to: '$dead-letter',
      contract: 'dead letter',
      internal: false,
      warning: false,
    }));

  return (
    <svg
      ref={svg}
      className={`h-full w-full select-none ${props.dimmed ? 'opacity-40' : ''}`}
      role="img"
      aria-label="flock graph"
    >
      <g transform={transform}>
        {[...props.layout.edges, ...deadEdges].map((edge) => {
          const d = pathOf(edge, nodes);
          if (!d) {
            return null;
          }

          return (
            <g key={edge.id}>
              <path id={`edge-${edge.id}`} d={d} fill="none" stroke="none" />
              <EdgeView
                edge={edge}
                d={d}
                failed={edge.to === '$dead-letter' || failedNodes.has(edge.from) || failedNodes.has(edge.to)}
                onEdge={() => props.onEdge(edge)}
                badge={props.suppressed(edge.id)}
              />
            </g>
          );
        })}
        {props.pulses.map((p) => {
          const edge = props.layout.edges.find((e) => e.id === p.edgeId);
          const d = edge ? pathOf(edge, nodes) : null;

          return d ? (
            <circle
              key={p.key}
              r={3.5}
              className="pulse-dot fill-accent"
              style={{ offsetPath: `path('${d}')`, animationDuration: `${PULSE_MS}ms` }}
            />
          ) : null;
        })}
        {props.layout.nodes.map((node) => (
          <g
            key={node.id}
            data-node={node.id}
            transform={`translate(${node.x},${node.y})`}
            className="cursor-pointer"
            onPointerDown={(e) => drag.down(node, e)}
            onPointerMove={drag.move}
            onPointerUp={drag.up}
          >
            <title>{node.members.length > 1 ? `${node.id} (${node.childCount} pieces)` : node.id}</title>
            <NodeBody node={node} live={props.live(node)} props={props} />
          </g>
        ))}
      </g>
    </svg>
  );
}
