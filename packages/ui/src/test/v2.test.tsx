// @vitest-environment jsdom
import type { PieceDetail, Trace, TraceNode } from '@murmur/dev-protocol';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { App } from '../App.tsx';
import { edgeText } from '../components/Graph.tsx';
import { layoutWaterfall } from '../components/waterfall-math.ts';
import { Waterfall } from '../components/Waterfall.tsx';
import { buildGraph } from '../graph/edges.ts';
import { assignLayers } from '../graph/layout.ts';
import { createStore, StoreContext } from '../store/store.ts';
import { FakeEventSource, helloFrame } from './event-source.ts';
import { envelope, v2Snapshot, present } from './fixtures.ts';

function pieceDetail(): PieceDetail {
  const rest = present(v2Snapshot().pieces[0]);

  return { ...rest, contextMd: null, files: [], recent: [], logs: [] };
}

function respond(url: string): unknown {
  if (url.startsWith('/api/pieces/api%2Frest')) {
    return pieceDetail();
  }

  if (url.startsWith('/api/logs')) {
    return { items: [] };
  }

  return [];
}

async function openAt(hash: string) {
  window.location.hash = hash;
  render(
    <StoreContext.Provider value={createStore()}>
      <App />
    </StoreContext.Provider>,
  );

  await act(async () => {
    FakeEventSource.last?.emit('hello', helloFrame(v2Snapshot()));
    await new Promise((resolve) => setTimeout(resolve, 80));
  });
}

beforeEach(() => {
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => new Response(JSON.stringify(respond(url)), { status: 200 })),
  );
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('v0.2 labels', () => {
  test('catalog contract rows show the kind badge and the class name with the wire name on hover', async () => {
    await openAt('#/catalog');
    const badges = screen.getAllByLabelText(/^kind /).map((badge) => badge.textContent);
    const name = screen.getByTitle('todos.CreateTodo');

    expect(badges).toEqual(['G', 'G', 'Q', 'Q', 'C', 'E']);
    expect(name.textContent).toBe('CreateTodo');
  });

  test('catalog shows the ROUTES table with effective guards and the new warnings with their why', async () => {
    await openAt('#/catalog');
    const routes = within(screen.getByLabelText('routes web'));
    const statsRow = present(routes.getByText('GET /stats').closest('tr'));

    expect(routes.getByText('ROUTES (web)')).toBeTruthy();
    expect(routes.getByText('api/rest.show')).toBeTruthy();
    expect(statsRow.textContent).toContain('RateLimit');
    expect(statsRow.textContent).not.toContain('Authenticate');
    expect(statsRow.textContent).toContain('→ GetStats');
    expect(screen.getByText('binding-conflict')).toBeTruthy();
    expect(screen.getByText(/two pieces claim one route/)).toBeTruthy();
    expect(screen.getByText(/one path family served by several pieces/)).toBeTruthy();
    expect(screen.getByText('route-shadowed')).toBeTruthy();
    expect(screen.getByText(/can never be reached because another piece matches it first/)).toBeTruthy();
    expect(screen.getByText('guard-output-overlap')).toBeTruthy();
    expect(screen.getByText(/two guards return the same field/)).toBeTruthy();
  });

  test('catalog lists event emitters and requesters in their own columns', async () => {
    await openAt('#/catalog');
    const statsRow = present(screen.getByTitle('stats.GetStats').closest('tr'));
    const cells = [...statsRow.querySelectorAll('td')].map((cell) => cell.textContent);

    expect(cells.slice(-3)).toEqual(['—', 'api/rest', 'stats']);
  });

  test('the piece page has a kind label and a Serves tab listing bindings with effective guards', async () => {
    await openAt('#/pieces/api/rest?tab=Serves');

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    const serves = within(screen.getByLabelText('serves'));
    const showRow = present(serves.getByText('GET /todos/:id').closest('tr'));

    expect(screen.getByRole('tab', { name: /Serves/ }).getAttribute('aria-selected')).toBe('true');
    expect(showRow.textContent).toContain('Authenticate');
    expect(showRow.textContent).toContain('RateLimit');
    expect(showRow.textContent).toContain('method show');
    expect(present(serves.getByText('GET /stats').closest('tr')).textContent).toContain('→ GetStats');
  });

  test('the overview tab labels the piece kind and class', async () => {
    await openAt('#/pieces/api/rest');

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(screen.getByLabelText('piece kind').textContent).toBe('edge');
    expect(screen.getByText('RestApi')).toBeTruthy();
  });
});

describe('flock graph v0.2', () => {
  const graph = () => buildGraph({ ...v2Snapshot(), expanded: new Set() });

  test('edge pieces sit in the leftmost column under the transport glyph', () => {
    const { nodes, edges } = graph();
    const layers = assignLayers(nodes, edges);

    expect(nodes.find((node) => node.id === 'api')?.pieceKind).toBe('mixed');
    expect(layers.get('ingress:web')).toBe(0);
    expect(layers.get('api')).toBe(1);
    expect(
      Math.min(present(layers.get('todos')), present(layers.get('stats')), present(layers.get('auth'))),
    ).toBeGreaterThan(1);
  });

  test('guard calls are dashed edges from the transport, contract edges carry the kind badge and class name', () => {
    const { edges } = graph();
    const guard = edges.find((e) => e.contract === 'auth.Authenticate');
    const query = edges.find((e) => e.contract === 'todos.GetTodo');

    expect(guard).toMatchObject({
      from: 'ingress:web',
      to: 'auth',
      guard: true,
      badge: 'G',
      label: 'Authenticate',
    });
    expect(query).toMatchObject({ from: 'api', to: 'todos', badge: 'Q', label: 'GetTodo' });
    expect(edgeText(present(query), 0)).toBe('Q GetTodo');
    expect(edgeText(present(query), 3)).toBe('Q GetTodo ×3');
  });
});

const t0 = Date.parse('2026-10-24T10:00:00.000Z');
const at = (ms: number) => new Date(t0 + ms).toISOString();

function acked(piece: string, from: number, to: number) {
  return {
    piece,
    attempt: 1,
    receivedAt: at(from),
    endedAt: at(to),
    durationMs: to - from,
    outcome: 'acked' as const,
  };
}

function traceNode(
  id: string,
  name: string,
  parentId: string | null,
  over: Partial<TraceNode> = {},
): TraceNode {
  return {
    id,
    parentId,
    depth: parentId === null ? 0 : 1,
    envelope: envelope({
      id,
      name,
      ts: at(parentId === null ? 0 : 2),
      ...(parentId ? { causationId: parentId } : {}),
    }),
    deliveries: [],
    ...over,
  };
}

function renderWaterfall(trace: Trace) {
  const guards = new Set(['auth.Authenticate', 'auth.RateLimit']);
  const model = layoutWaterfall(trace, t0 + 100, { guards });
  render(
    <Waterfall
      model={model}
      collapsed={new Set()}
      selected={null}
      logs={null}
      onSelect={() => {}}
      onHover={() => {}}
    />,
  );

  return model;
}

function traceOf(nodes: TraceNode[], over: Partial<Trace> = {}): Trace {
  return {
    traceId: 't1',
    root: { seq: 1, envelope: present(nodes[0]).envelope, meta: { internal: false, piece: 'api/rest' } },
    nodes,
    startedAt: at(0),
    endedAt: at(40),
    durationMs: 40,
    failed: false,
    maxHop: 1,
    ...over,
  };
}

describe('waterfall v0.2', () => {
  test('an ingress root with guard requests first and a rejected guard as an acked delivery with a badge', () => {
    const model = renderWaterfall(
      traceOf([
        traceNode('in1', '$ingress.http', null),
        traceNode('q1', 'todos.GetTodo', 'in1', {
          envelope: envelope({ id: 'q1', name: 'todos.GetTodo', ts: at(1), causationId: 'in1' }),
        }),
        traceNode('g1', 'auth.Authenticate', 'in1', {
          deliveries: [acked('auth', 3, 4)],
          reply: { envelopeId: 'r1', durationMs: 3, timedOut: false, rejected: 401 },
        }),
      ]),
    );

    expect(model.rows.map((row) => row.name)).toEqual([
      '$ingress.http',
      'auth.Authenticate',
      'todos.GetTodo',
    ]);
    expect(model.rows[0]).toMatchObject({
      piece: 'api/rest',
      origin: { kind: 'ingress', piece: 'api/rest' },
    });
    expect(model.rows[1]?.bars.map((bar) => bar.outcome)).toEqual(['acked']);
    expect(screen.getByLabelText('trace root').textContent).toBe('ingress');
    expect(screen.getByText('rejected 401')).toBeTruthy();
  });

  test('a deduplicated query shows ×N with a dashed edge from the suppressed caller', () => {
    renderWaterfall(
      traceOf([
        traceNode('e1', 'todos.TodoCreated', null, { deliveries: [acked('stats', 1, 9)] }),
        traceNode('q1', 'todos.GetTodo', 'e1', {
          envelope: envelope({
            id: 'q1',
            name: 'todos.GetTodo',
            ts: at(2),
            causationId: 'e1',
            source: 'stats',
          }),
          deliveries: [acked('todos', 3, 5)],
          deduped: { count: 1, by: ['stats'] },
        }),
      ]),
    );

    expect(screen.getByTitle('deduplicated for stats').textContent).toBe('×2');
    expect(document.body.querySelectorAll('line[data-dedupe]').length).toBe(1);
  });

  test('the dashed dedupe edge starts only at the caller row next to the request, not at its other deliveries', () => {
    renderWaterfall(
      traceOf([
        traceNode('e0', 'todos.TodoCreated', null, { deliveries: [acked('stats', 1, 3)] }),
        traceNode('e1', 'todos.TodoCompleted', 'e0', { deliveries: [acked('stats', 3, 9)] }),
        traceNode('q1', 'todos.GetTodo', 'e1', {
          envelope: envelope({
            id: 'q1',
            name: 'todos.GetTodo',
            ts: at(4),
            causationId: 'e1',
            source: 'stats',
          }),
          deliveries: [acked('todos', 4, 6)],
          deduped: { count: 1, by: ['stats'] },
        }),
      ]),
    );

    expect(document.body.querySelectorAll('line[data-dedupe]').length).toBe(1);
  });

  test('a dead-lettered lane shows the failure reason next to its error', () => {
    const deadLettered = {
      ...acked('todos', 1, 5),
      outcome: 'deadLettered' as const,
      error: 'Error: requester gone',
      reason: 'requester-gone',
    };
    const model = layoutWaterfall(
      traceOf([traceNode('c1', 'todos.CreateTodo', null, { deliveries: [deadLettered] })]),
      t0 + 100,
    );

    expect(model.rows[0]?.bars[0]?.error).toBe('Error: requester gone (requester-gone)');
  });

  test('a background root is labelled', () => {
    const model = renderWaterfall(
      traceOf([traceNode('e1', 'todos.TodoCreated', null, { deliveries: [acked('stats', 1, 9)] })], {
        background: { piece: 'api/feed' },
      }),
    );

    expect(model.rows[0]?.origin).toEqual({ kind: 'background', piece: 'api/feed' });
    expect(screen.getByLabelText('trace root').textContent).toBe('background');
  });
});
