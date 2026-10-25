import type { TreeNode } from '@murmur/dev-protocol';
import { useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';

import { ancestors, flattenVisible } from '../store/tree.ts';
import { StatusDot, type DotTone } from './StatusDot.tsx';

export interface TreeRowStats {
  tone: DotTone;
  inflight: number;
  failed: number;
}

export function filterTree(nodes: TreeNode[], query: string): TreeNode[] {
  const q = query.trim().toLowerCase();
  if (!q) {
    return nodes;
  }

  return nodes.flatMap((node) => {
    const children = filterTree(node.children, q);
    const hit = node.id.toLowerCase().includes(q) || node.title.toLowerCase().includes(q);

    if (!hit && !children.length) {
      return [];
    }

    return [{ ...node, children: hit ? node.children : children }];
  });
}

function allIds(nodes: TreeNode[]): string[] {
  return nodes.flatMap((n) => [n.id, ...allIds(n.children)]);
}

interface TreeProps {
  tree: TreeNode[];
  expanded: ReadonlySet<string>;
  selected: string | null;
  onToggle: (id: string, open?: boolean) => void;
  onOpen: (node: TreeNode) => void;
  stats: (node: TreeNode) => TreeRowStats;
}

function Row({
  node,
  depth,
  props,
  cursor,
}: {
  node: TreeNode;
  depth: number;
  props: TreeProps;
  cursor: boolean;
}) {
  const s = props.stats(node);
  const open = props.expanded.has(node.id);

  return (
    <div
      role="treeitem"
      aria-expanded={node.children.length ? open : undefined}
      aria-selected={props.selected === node.id}
      className={`flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 ${props.selected === node.id ? 'bg-accent/15' : 'hover:bg-panel'} ${cursor ? 'ring-1 ring-accent/50' : ''}`}
      style={{ paddingLeft: depth * 12 + 4 }}
      title={node.summary ?? node.id}
      onClick={() => props.onOpen(node)}
    >
      <button
        type="button"
        className={`w-3 text-ink-muted ${node.children.length ? '' : 'invisible'}`}
        onClick={(e) => {
          e.stopPropagation();
          props.onToggle(node.id);
        }}
        aria-label={open ? 'collapse' : 'expand'}
      >
        {open ? '▾' : '▸'}
      </button>
      <StatusDot tone={s.tone} />
      <span className={`flex-1 truncate ${node.kind === 'group' ? 'text-ink-muted' : ''}`}>{node.title}</span>
      {s.inflight ? (
        <span className="rounded bg-accent/15 px-1 font-mono text-[10px] text-accent">{s.inflight}</span>
      ) : null}
      {s.failed ? (
        <span className="rounded bg-fail/15 px-1 font-mono text-[10px] text-fail">{s.failed}</span>
      ) : null}
    </div>
  );
}

function Rows({
  nodes,
  depth,
  props,
  cursorId,
}: {
  nodes: TreeNode[];
  depth: number;
  props: TreeProps;
  cursorId: string | null;
}) {
  return nodes.map((node) => (
    <div key={node.id}>
      <Row node={node} depth={depth} props={props} cursor={cursorId === node.id} />
      {props.expanded.has(node.id) ? (
        <Rows nodes={node.children} depth={depth + 1} props={props} cursorId={cursorId} />
      ) : null}
    </div>
  ));
}

export function Tree(props: TreeProps): ReactNode {
  const [query, setQuery] = useState('');
  const [cursorId, setCursorId] = useState<string | null>(null);
  const nodes = useMemo(() => filterTree(props.tree, query), [props.tree, query]);
  const expanded = useMemo(
    () => (query ? new Set(allIds(nodes)) : props.expanded),
    [query, nodes, props.expanded],
  );
  const view = { ...props, expanded };
  const visible = flattenVisible(nodes, expanded);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).tagName === 'INPUT') {
      return;
    }

    const index = visible.findIndex((n) => n.id === (cursorId ?? props.selected));
    const current = visible[index];
    const move = (delta: number) =>
      setCursorId(visible[Math.min(visible.length - 1, Math.max(0, index + delta))]?.id ?? null);

    if (e.key === 'j') {
      move(1);
    } else if (e.key === 'k') {
      move(-1);
    } else if (e.key === 'l' && current) {
      props.onToggle(current.id, true);
    } else if (e.key === 'h' && current) {
      if (expanded.has(current.id)) {
        props.onToggle(current.id, false);
      } else {
        setCursorId(ancestors(current.id).at(-1) ?? current.id);
      }
    } else if (e.key === 'Enter' && current) {
      props.onOpen(current);
    } else {
      return;
    }

    e.preventDefault();
  };

  return (
    <div className="flex h-full flex-col gap-2 p-2" onKeyDown={onKeyDown}>
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="filter pieces"
        aria-label="filter pieces"
        className="rounded border border-line bg-paper px-2 py-1 text-xs outline-none focus:border-accent"
      />
      <div
        role="tree"
        tabIndex={0}
        className="flex-1 overflow-auto outline-none focus:ring-1 focus:ring-accent/40"
      >
        {nodes.length ? (
          <Rows nodes={nodes} depth={0} props={view} cursorId={cursorId} />
        ) : (
          <p className="p-2 text-ink-muted">no pieces</p>
        )}
      </div>
    </div>
  );
}
