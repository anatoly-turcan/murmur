import { join } from 'node:path';

import type { Trace } from '@murmur/dev-protocol';

import {
  flag,
  intOption,
  requirePositional,
  stringOption,
  type Command,
  type CommandContext,
} from '../command.ts';
import { devServer, getJson } from '../dev/client.ts';
import { findTraceFiles, readTraceItems } from '../dev/trace-store.ts';
import { buildTrace } from '../dev/trace.ts';
import { CliError, EXIT, usageError } from '../errors.ts';
import { renderWaterfall } from '../render/waterfall.ts';
import { requireRoot } from '../root.ts';

const USAGE = 'trace <traceId|prefix> [--from <file.ndjson|dir>] [--json] [--payload] [--width 100]';

type Lookup = { found: Trace } | { candidates: string[] } | null;

function ambiguous(candidates: readonly string[]): CliError {
  return usageError(`trace prefix is ambiguous`, `candidates: ${candidates.join(', ')}`);
}

async function fromServer(base: string, prefix: string): Promise<Lookup> {
  const { status, body } = await getJson<Trace & { error?: { candidates?: string[] } }>(
    `${base}/api/traces/${encodeURIComponent(prefix)}`,
  );

  if (status === 200) {
    return { found: body };
  }

  if (status === 409) {
    return { candidates: body.error?.candidates ?? [] };
  }

  return null;
}

function fromFiles(source: string, prefix: string): Lookup {
  const traces = findTraceFiles(source, prefix).flatMap((file) => {
    const items = readTraceItems(file, prefix);
    const ids = [...new Set(items.map((item) => item.envelope.traceId))];

    return ids.flatMap((id) => buildTrace(items.filter((item) => item.envelope.traceId === id)) ?? []);
  });

  if (traces.length > 1) {
    return { candidates: traces.map((trace) => trace.traceId) };
  }

  return traces[0] === undefined ? null : { found: traces[0] };
}

async function lookup(
  ctx: CommandContext,
  prefix: string,
): Promise<{ trace: Trace | null; server: boolean }> {
  const root = requireRoot(ctx.cwd);
  const base = await devServer(root);
  const from = stringOption(ctx, 'from');
  const sources: (() => Lookup | Promise<Lookup>)[] = [
    ...(base === null ? [] : [() => fromServer(base, prefix)]),
    ...(from === undefined ? [] : [() => fromFiles(from, prefix)]),
    () => fromFiles(join(root, '.murmur', 'traces'), prefix),
  ];

  for (const source of sources) {
    const result = await source();
    if (result !== null && 'candidates' in result) {
      throw ambiguous(result.candidates);
    }

    if (result !== null) {
      return { trace: result.found, server: base !== null };
    }
  }

  return { trace: null, server: base !== null };
}

async function run(ctx: CommandContext): Promise<number> {
  const prefix = requirePositional(ctx, 0, 'trace id', USAGE);
  const { trace, server } = await lookup(ctx, prefix);

  if (trace === null) {
    if (!server && stringOption(ctx, 'from') === undefined) {
      throw new CliError(
        EXIT.noDevServer,
        `trace ${prefix} not found and no dev server is running`,
        'start `murmur dev` or pass --from',
      );
    }

    throw usageError(`no trace ${prefix}`);
  }

  if (ctx.out.json) {
    ctx.out.emit({ kind: 'trace', ...trace });
  } else {
    ctx.out.print(
      renderWaterfall(trace, { width: intOption(ctx, 'width') ?? 100, payload: flag(ctx, 'payload') }),
    );
  }

  return EXIT.ok;
}

export const traceCommand: Command = {
  usage: USAGE,
  options: { from: { type: 'string' }, payload: { type: 'boolean' }, width: { type: 'string' } },
  run,
};
