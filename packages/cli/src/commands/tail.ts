import type { Catalog, EnvelopesPage, Frame, StoredEnvelope } from '@murmur/dev-protocol';

import { flag, stringOption, type Command, type CommandContext } from '../command.ts';
import { frames, getJson, requireDevServer } from '../dev/client.ts';
import { matchesEnv, type EnvFilter } from '../dev/filter.ts';
import { parseSince, type Since } from '../dev/since.ts';
import { EXIT, usageError } from '../errors.ts';
import type { Output } from '../output.ts';
import { tailLine, type TailOptions } from '../render/tail.ts';
import { instantMs } from '../render/time.ts';
import { requireRoot } from '../root.ts';

const USAGE =
  'tail [--piece <glob>] [--contract <glob>] [--trace <id>] [--failed] [--internal] [--since <seq|duration>] [--no-follow] [--payload] [--json]';

type Print = (frame: Frame) => void;

function filterOf(ctx: CommandContext): EnvFilter {
  return {
    piece: stringOption(ctx, 'piece'),
    contract: stringOption(ctx, 'contract'),
    trace: stringOption(ctx, 'trace'),
  };
}

function query(filter: EnvFilter, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams(extra);
  for (const [key, value] of Object.entries(filter)) {
    if (typeof value === 'string') {
      params.set(key, value);
    }
  }

  return params.toString();
}

function sinceOption(ctx: CommandContext): Since | null {
  const text = stringOption(ctx, 'since');
  const since = parseSince(text);

  if (text !== undefined && since === null) {
    throw usageError('--since must be a seq number or a duration like 30s, 5m');
  }

  return since;
}

function afterSince(stored: StoredEnvelope, since: Since | null): boolean {
  if (since === null) {
    return true;
  }

  if (since.kind === 'seq') {
    return stored.seq > since.seq;
  }

  return instantMs(stored.envelope.ts) >= Date.now() - since.ms;
}

function wanted(frame: Frame, ctx: CommandContext): boolean {
  if (frame.frame !== 'env') {
    return frame.frame !== 'hello' && frame.frame !== 'ping';
  }

  if (flag(ctx, 'failed')) {
    return frame.meta.failed === true;
  }

  return flag(ctx, 'internal') || !frame.meta.internal || frame.meta.failed === true;
}

function printer(out: Output, ctx: CommandContext, handlers: Map<string, readonly string[]>): Print {
  const options: TailOptions = {
    internal: flag(ctx, 'internal'),
    failed: flag(ctx, 'failed'),
    payload: flag(ctx, 'payload'),
    handlers: (name) => handlers.get(name) ?? [],
  };

  return (frame) => {
    if (!wanted(frame, ctx)) {
      return;
    }

    if (out.json) {
      out.stream(frame);
    } else {
      const line = tailLine(frame, options);
      if (line !== null) {
        out.print(line);
      }
    }
  };
}

async function handlersOf(base: string): Promise<Map<string, readonly string[]>> {
  const { body } = await getJson<Catalog>(`${base}/api/catalog`);

  return new Map(body.contracts.map((contract) => [contract.name, contract.handlers]));
}

async function buffered(base: string, filter: EnvFilter, since: Since | null): Promise<StoredEnvelope[]> {
  const items: StoredEnvelope[] = [];
  let before: number | null = null;

  do {
    const extra: Record<string, string> = {
      limit: '1000',
      ...(before === null ? {} : { before: String(before) }),
    };

    const { body }: { body: EnvelopesPage } = await getJson<EnvelopesPage>(
      `${base}/api/envelopes?${query(filter, extra)}`,
    );

    items.unshift(...body.items);
    before = body.items.some((stored) => !afterSince(stored, since)) ? null : body.nextBefore;
  } while (before !== null);

  return items.filter((stored) => afterSince(stored, since));
}

function envFrame(stored: StoredEnvelope): Frame {
  return {
    frame: 'env',
    seq: stored.seq,
    ts: stored.envelope.ts,
    envelope: stored.envelope,
    meta: stored.meta,
  };
}

async function follow(base: string, filter: EnvFilter, ctx: CommandContext, print: Print): Promise<number> {
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  const since = stringOption(ctx, 'since');
  const url = `${base}/api/events?${query(filter, since === undefined ? {} : { since })}`;

  try {
    for await (const frame of frames(url, controller.signal)) {
      if (matchesFrame(frame, filter)) {
        print(frame);
      }
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      throw error;
    }
  }

  return controller.signal.aborted ? EXIT.ok : EXIT.noDevServer;
}

function matchesFrame(frame: Frame, filter: EnvFilter): boolean {
  return frame.frame !== 'env' || matchesEnv(frame, filter);
}

async function run(ctx: CommandContext): Promise<number> {
  const base = await requireDevServer(requireRoot(ctx.cwd));
  const filter = filterOf(ctx);
  const since = sinceOption(ctx);
  const print = printer(ctx.out, ctx, ctx.out.json ? new Map() : await handlersOf(base));

  if (ctx.values['follow'] !== false) {
    return follow(base, filter, ctx, print);
  }

  for (const stored of await buffered(base, filter, since)) {
    print(envFrame(stored));
  }

  return EXIT.ok;
}

export const tailCommand: Command = {
  usage: USAGE,
  options: {
    piece: { type: 'string' },
    contract: { type: 'string' },
    trace: { type: 'string' },
    failed: { type: 'boolean' },
    internal: { type: 'boolean' },
    since: { type: 'string' },
    follow: { type: 'boolean', default: true },
    payload: { type: 'boolean' },
  },
  run,
};
