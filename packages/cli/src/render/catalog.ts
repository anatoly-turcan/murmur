import { sendersOf } from '../analysis/catalog.ts';
import { table } from '../analysis/markdown.ts';
import type {
  Catalog,
  CatalogRoute,
  CatalogWarning,
  ContractView,
  PieceView,
  TreeNode,
} from '../analysis/types.ts';
import { renderTable } from './table.ts';

const dash = (list: readonly string[]) => (list.length === 0 ? '—' : list.join(', '));

function visibility(contract: ContractView): string {
  return contract.visibility === 'public' ? 'public' : (contract.scope ?? 'internal');
}

function warningsFor(catalog: Catalog, subject: string): string {
  return catalog.warnings
    .filter((w) => w.subject === subject)
    .map((w) => `⚠ ${w.code}`)
    .join(' ');
}

function contractRows(catalog: Catalog): string[][] {
  return catalog.contracts.map((c) => [
    c.name,
    c.kind,
    visibility(c),
    dash(sendersOf(c)),
    dash(c.handlers),
    warningsFor(catalog, c.name),
  ]);
}

function flatten(nodes: readonly TreeNode[]): TreeNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children)]);
}

function pieceRows(catalog: Catalog): string[][] {
  const views = new Map(catalog.pieces.map((p) => [p.name, p]));

  return flatten(catalog.tree).flatMap((node): string[][] => {
    const view = views.get(node.id);
    if (view === undefined) {
      if (node.kind !== 'group') {
        return [];
      }

      return [groupRow(node)];
    }

    return [pieceRow(view, warningsFor(catalog, view.name))];
  });
}

function groupRow(node: TreeNode): string[] {
  const kind = node.children.length === 0 ? 'leaf, no piece.ts' : 'group';
  const blanks = Array.from({ length: 8 }, () => '');

  return [`${node.id}/`, '', kind, ...blanks, node.summary ?? node.title];
}

function count(list: readonly string[]): string {
  return list.length === 0 ? '—' : String(list.length);
}

function pieceRow(view: PieceView, warnings: string): string[] {
  return [
    view.name,
    view.className ?? '—',
    view.kind,
    dash(view.needFields.length > 0 ? view.needFields : view.needs),
    dash(view.config.map((c) => c.env.split('__').at(-1) ?? c.key)),
    count(view.handles),
    count(view.serves),
    count(view.emits),
    count(view.requests),
    view.hasTests ? 'yes' : 'no',
    view.hasContextMd ? 'yes' : 'no',
    warnings,
  ];
}

function capabilityRows(catalog: Catalog): string[][] {
  return catalog.capabilities.map((c) => [
    c.name,
    c.kind,
    c.routes === undefined ? dash(c.usedBy) : `(routes: ${c.routes})`,
  ]);
}

function otherWarnings(catalog: Catalog): CatalogWarning[] {
  const shown = new Set([...catalog.contracts.map((c) => c.name), ...catalog.pieces.map((p) => p.name)]);

  return catalog.warnings.filter((w) => !shown.has(w.subject));
}

function classNames(catalog: Catalog, wireNames: readonly string[]): string[] {
  return wireNames.map((name) => catalog.contracts.find((c) => c.name === name)?.className ?? name);
}

function via(route: CatalogRoute): string {
  if (route.contract === undefined) {
    return 'method';
  }

  const status = route.status === undefined ? '' : ` (${route.status})`;

  return `→ ${route.contract}${status}`;
}

function routeFlag(catalog: Catalog, route: CatalogRoute): string {
  const codes = new Set(['binding-conflict', 'route-shadowed']);
  const flagged = catalog.errors.some((e) => codes.has(e.code) && e.message.includes(route.key));

  return flagged ? '⚠' : '';
}

function routeCells(catalog: Catalog, route: CatalogRoute): string[] {
  return [
    route.key,
    route.method === undefined ? route.piece : `${route.piece}.${route.method}`,
    dash(classNames(catalog, route.guards)),
    via(route),
  ];
}

function routeRows(catalog: Catalog, token: string): string[][] {
  return catalog.routes
    .filter((route) => route.token === token)
    .map((route) => ['', ...routeCells(catalog, route), routeFlag(catalog, route)]);
}

export function renderRoutes(catalog: Catalog): string[] {
  const tokens = [...new Set(catalog.routes.map((route) => route.token))];

  return tokens.map((token) =>
    renderTable([`ROUTES (${token})`, 'key', 'piece', 'guards', 'via', ''], routeRows(catalog, token)),
  );
}

const CONTRACT_HEADER = ['CONTRACTS', 'kind', 'vis', 'requested / emitted by', 'handled by', ''];
const PIECE_HEADER = [
  'PIECES',
  'class',
  'kind',
  'needs',
  'config',
  'handles',
  'serves',
  'emits',
  'requests',
  'tests',
  'context.md',
  '',
];
const CAPABILITY_HEADER = ['CAPABILITIES', 'kind', 'used by'];

export function renderCatalogTable(catalog: Catalog): string {
  const extra = otherWarnings(catalog).map((w) => `⚠ ${w.code}: ${w.message}`);

  return [
    renderTable(CONTRACT_HEADER, contractRows(catalog)),
    renderTable(PIECE_HEADER, pieceRows(catalog)),
    ...renderRoutes(catalog),
    renderTable(CAPABILITY_HEADER, capabilityRows(catalog)),
    ...(extra.length === 0 ? [] : [extra.join('\n')]),
  ].join('\n\n');
}

export function renderCatalogMarkdown(catalog: Catalog): string {
  const warnings = catalog.warnings.map((w) => `- ⚠ ${w.code}: ${w.message}`);

  return [
    '### Contracts',
    table(
      ['contract', 'kind', 'vis', 'requested / emitted by', 'handled by'],
      contractRows(catalog).map((r) => r.slice(0, 5)),
    ),
    '### Pieces',
    table(
      PIECE_HEADER.slice(0, 11).with(0, 'piece'),
      pieceRows(catalog).map((r) => r.slice(0, 11)),
    ),
    ...(catalog.routes.length === 0
      ? []
      : [
          '### Routes',
          table(
            ['token', 'key', 'piece', 'guards', 'via'],
            catalog.routes.map((route) => [route.token, ...routeCells(catalog, route)]),
          ),
        ]),
    '### Capabilities',
    table(['capability', 'kind', 'used by'], capabilityRows(catalog)),
    ...(warnings.length === 0 ? [] : ['### Warnings', warnings.join('\n')]),
  ].join('\n\n');
}

function nodeId(id: string): string {
  return `n_${id.replace(/[^a-z0-9]/gi, '_')}`;
}

function mermaidGroup(node: TreeNode, pieces: ReadonlySet<string>, indent: string): string[] {
  const own = pieces.has(node.id) ? [`${indent}${nodeId(node.id)}["${node.id}"]`] : [];
  const inner = node.children.flatMap((child) => mermaidGroup(child, pieces, `${indent}  `));

  if (node.children.length === 0 || (own.length === 0 && inner.length === 0)) {
    return own;
  }

  return [`${indent}subgraph ${nodeId(`g_${node.id}`)}["${node.id}/"]`, ...own, ...inner, `${indent}end`];
}

function edgePiecesByToken(catalog: Catalog): Map<string, string[]> {
  const edges = new Set(catalog.pieces.filter((p) => p.kind !== 'domain').map((p) => p.name));
  const byToken = new Map<string, string[]>();

  for (const route of catalog.routes) {
    const label = `${route.token} (${route.transport})`;
    const members = byToken.get(label) ?? [];

    if (edges.has(route.piece) && !members.includes(route.piece)) {
      byToken.set(label, [...members, route.piece]);
    }
  }

  return byToken;
}

function transportGroup(label: string, members: readonly string[]): string[] {
  return [
    `  subgraph ${nodeId(`t_${label}`)}["${label}"]`,
    ...members.map((id) => `    ${nodeId(id)}["${id}"]`),
    '  end',
  ];
}

function contractEdges(contract: ContractView): string[] {
  const arrow = contract.kind === 'guard' ? '-.->' : '-->';

  return sendersOf(contract).flatMap((from) =>
    contract.handlers.map((to) => `  ${nodeId(from)} ${arrow}|${contract.name}| ${nodeId(to)}`),
  );
}

export function renderCatalogMermaid(catalog: Catalog): string {
  const pieces = new Set(catalog.pieces.map((p) => p.name));
  const transports = edgePiecesByToken(catalog);
  const atEdge = new Set([...transports.values()].flat());
  const inFolders = new Set([...pieces].filter((id) => !atEdge.has(id)));
  const externals = [
    ...new Set(catalog.contracts.flatMap((c) => sendersOf(c).filter((e) => !pieces.has(e)))),
  ];

  return [
    'flowchart LR',
    ...[...transports.entries()].flatMap(([label, members]) => transportGroup(label, members)),
    ...catalog.tree.flatMap((node) => mermaidGroup(node, inFolders, '  ')),
    ...externals.map((e) => `  ${nodeId(e)}(["${e}"])`),
    ...catalog.contracts.flatMap(contractEdges),
  ].join('\n');
}
