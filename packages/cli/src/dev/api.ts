import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

import type {
  ContextResponse,
  ContractSchemaResponse,
  EmitRequest,
  HealthResponse,
  LogLine,
  LogsResponse,
  PieceDetail,
} from '@murmur/dev-protocol';

import { assembleContext } from '../analysis/context.ts';
import { CallError } from './child-process.ts';
import type { DevContext } from './context.ts';
import { filterOf } from './filter.ts';
import { toCatalog, toPieceView, toTree } from './snapshot.ts';
import { buildTrace } from './trace.ts';

export interface ApiRequest {
  readonly params: Readonly<Record<string, string>>;
  readonly query: URLSearchParams;
  readonly body: unknown;
}

export interface ApiResult {
  readonly status: number;
  readonly body: unknown;
}

export type ApiHandler = (ctx: DevContext, req: ApiRequest) => Promise<ApiResult>;

const RECENT = 50;
const MODES = new Set(['emit', 'request']);

const ok = (body: unknown): ApiResult => ({ status: 200, body });
const fail = (status: number, message: string, extra: object = {}): ApiResult => ({
  status,
  body: { error: { message, ...extra } },
});

function intParam(query: URLSearchParams, key: string, fallback: number): number {
  const value = Number(query.get(key) ?? Number.NaN);

  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

async function health(ctx: DevContext): Promise<ApiResult> {
  const info = ctx.live.info();
  const catalog = ctx.cachedAnalysis()?.catalog;
  const body: HealthResponse = {
    ok: true,
    protocol: 1,
    app: info?.app ?? basename(ctx.root),
    pid: process.pid,
    startedAt: ctx.startedAt,
    pieces: info?.pieces.length ?? catalog?.pieces.length ?? 0,
    uptimeMs: Math.round(process.uptime() * 1000),
  };

  return ok(body);
}

async function envelopes(ctx: DevContext, req: ApiRequest): Promise<ApiResult> {
  const limit = Math.min(intParam(req.query, 'limit', 100), 1_000);
  const before = req.query.has('before') ? intParam(req.query, 'before', 0) : null;

  return ok(ctx.replay.page(filterOf(req.query), limit, before));
}

async function trace(ctx: DevContext, req: ApiRequest): Promise<ApiResult> {
  const candidates = ctx.replay.traceIds(req.params['traceId'] ?? '');
  const exact = candidates.find((id) => id === req.params['traceId']);
  const traceIds = exact === undefined ? candidates : [exact];
  const traces = traceIds.flatMap((id) => buildTrace(ctx.replay.byTrace(id)) ?? []);

  if (traces.length === 0) {
    return fail(404, `no trace ${req.params['traceId']} in the replay buffer`);
  }

  if (traces.length > 1) {
    return fail(409, 'ambiguous trace prefix', { candidates: traces.map((found) => found.traceId) });
  }

  return ok(traces[0]);
}

async function pieces(ctx: DevContext): Promise<ApiResult> {
  const { catalog } = await ctx.analysis();

  return ok(catalog.pieces.map((view) => toPieceView(view, ctx.live)));
}

function filesOf(dir: string, files: readonly string[]): PieceDetail['files'] {
  return files.map((path) => ({
    path,
    bytes: statSync(join(dir, path), { throwIfNoEntry: false })?.size ?? 0,
  }));
}

async function pieceDetail(ctx: DevContext, req: ApiRequest): Promise<ApiResult> {
  const id = req.params['id'] ?? '';
  const analysis = await ctx.analysis();
  const view = analysis.catalog.pieces.find((candidate) => candidate.name === id);
  const node = analysis.repo.folders.get(id);

  if (view === undefined || node === undefined) {
    return fail(404, `no piece ${id}`);
  }

  const detail: PieceDetail = {
    ...toPieceView(view, ctx.live),
    contextMd:
      node.contextFile !== null && existsSync(node.contextFile)
        ? readFileSync(node.contextFile, 'utf8')
        : null,
    files: filesOf(node.dir, node.files),
    recent: ctx.replay.byPiece(id, RECENT),
    logs: ctx.live
      .logs()
      .filter((line) => line.piece === id)
      .slice(-RECENT),
  };

  return ok(detail);
}

async function context(ctx: DevContext, req: ApiRequest): Promise<ApiResult> {
  const id = req.params['id'] ?? '';
  const analysis = await ctx.analysis();

  if (id === '' || !analysis.repo.folders.has(id)) {
    return fail(404, `no piece or folder ${id}`);
  }

  const budget = req.query.has('budget') ? intParam(req.query, 'budget', 0) : null;
  const result = assembleContext(analysis, id, { budget });
  const body: ContextResponse = {
    markdown: result.markdown,
    sections: result.sections.map(({ id: section, title, tokens, level }) => ({
      id: section,
      title,
      tokens,
      level,
      truncated: level > 0,
    })),
    tokens: result.tokens,
    budget: result.budget,
    overBudget: result.overBudget,
    sizing: result.sizing,
  };

  return ok(body);
}

async function schema(ctx: DevContext, req: ApiRequest): Promise<ApiResult> {
  const name = req.params['name'] ?? '';
  const { catalog } = await ctx.analysis();
  const found = catalog.contracts.find((contract) => contract.name === name);

  if (found === undefined) {
    return fail(404, `no contract ${name}`);
  }

  const body: ContractSchemaResponse = {
    name,
    hasReply: found.hasReply,
    payload: found.schema?.payload ?? null,
    ...(found.schema?.reply === undefined ? {} : { reply: found.schema.reply }),
  };

  return ok(body);
}

function emitRequest(body: unknown): EmitRequest | null {
  const candidate = body as Partial<EmitRequest> | null;
  if (typeof candidate?.contract !== 'string' || !MODES.has(candidate.mode ?? '')) {
    return null;
  }

  if (candidate.timeoutMs !== undefined && typeof candidate.timeoutMs !== 'number') {
    return null;
  }

  return { ...candidate, payload: candidate.payload ?? {} } as EmitRequest;
}

async function forward(run: () => Promise<unknown>): Promise<ApiResult> {
  try {
    return ok(await run());
  } catch (error) {
    if (error instanceof CallError) {
      return { status: error.failure.status, body: { error: error.failure.error } };
    }

    throw error;
  }
}

async function emit(ctx: DevContext, req: ApiRequest): Promise<ApiResult> {
  const request = emitRequest(req.body);
  if (request === null) {
    return fail(400, "body must be { contract, payload, mode: 'emit' | 'request', timeoutMs? }");
  }

  return forward(() => ctx.call({ op: 'emit', request }));
}

function pauseHandler(op: 'pause' | 'resume'): ApiHandler {
  return (ctx) =>
    forward(async () => {
      const result = (await ctx.call({ op })) as { paused: boolean };
      ctx.paused(result.paused);

      return result;
    });
}

function logMatches(line: LogLine, query: URLSearchParams): boolean {
  const piece = query.get('piece');
  const traceId = query.get('trace');
  const level = query.get('level');

  return (
    (piece === null || line.piece === piece) &&
    (traceId === null || (line.traceId?.startsWith(traceId) ?? false)) &&
    (level === null || line.level === level)
  );
}

async function logs(ctx: DevContext, req: ApiRequest): Promise<ApiResult> {
  const limit = Math.min(intParam(req.query, 'limit', 200), 2_000);
  const body: LogsResponse = {
    items: ctx.live
      .logs()
      .filter((line) => logMatches(line, req.query))
      .slice(-limit),
  };

  return ok(body);
}

export const ROUTES: ReadonlyArray<readonly [method: string, pattern: string, handler: ApiHandler]> = [
  ['GET', '/api/health', health],
  ['GET', '/api/snapshot', async (ctx) => ok(await ctx.snapshot())],
  ['GET', '/api/envelopes', envelopes],
  ['GET', '/api/traces/:traceId', trace],
  ['GET', '/api/tree', async (ctx) => ok(toTree((await ctx.analysis()).catalog.tree))],
  ['GET', '/api/pieces', pieces],
  ['GET', '/api/pieces/:id', pieceDetail],
  ['GET', '/api/pieces/:id/context', context],
  ['GET', '/api/catalog', async (ctx) => ok(toCatalog((await ctx.analysis()).catalog, ctx.live))],
  ['GET', '/api/contracts/:name/schema', schema],
  ['POST', '/api/emit', emit],
  [
    'POST',
    '/api/restart',
    async (ctx) => {
      ctx.restart(['api']);

      return ok({ ok: true });
    },
  ],
  ['POST', '/api/pause', pauseHandler('pause')],
  ['POST', '/api/resume', pauseHandler('resume')],
  ['GET', '/api/logs', logs],
];
