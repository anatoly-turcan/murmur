import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { EmitRequest, EmitResponse } from '@murmur/dev-protocol';

import {
  flag,
  intOption,
  requirePositional,
  stringOption,
  type Command,
  type CommandContext,
} from '../command.ts';
import { postJson, requireDevServer } from '../dev/client.ts';
import { CliError, EXIT, usageError } from '../errors.ts';
import { requireRoot } from '../root.ts';

const USAGE = "emit <Contract> [--payload '<json>' | --fixture <file>] [--request] [--timeout 5000]";

interface ErrorBody {
  readonly error: { readonly name?: string; readonly message: string; readonly issues?: unknown };
}

function payloadOf(ctx: CommandContext): unknown {
  const text = stringOption(ctx, 'payload');
  const fixture = stringOption(ctx, 'fixture');

  if (text !== undefined && fixture !== undefined) {
    throw usageError('pass --payload or --fixture, not both');
  }

  const source = fixture === undefined ? text : readFileSync(resolve(fixture), 'utf8');
  if (source === undefined) {
    return {};
  }

  try {
    return JSON.parse(source) as unknown;
  } catch (error) {
    throw usageError(`payload is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function failure(status: number, body: ErrorBody): CliError {
  const issues = body.error.issues === undefined ? undefined : JSON.stringify(body.error.issues);
  const message = `${body.error.name ?? 'error'}: ${body.error.message}`;

  if (body.error.name === 'ContractViolationError') {
    return new CliError(EXIT.findings, message, issues);
  }

  if (status === 400 || status === 404) {
    return new CliError(EXIT.usage, message, issues);
  }

  return new CliError(status === 503 ? EXIT.boot : EXIT.findings, message, issues);
}

async function run(ctx: CommandContext): Promise<number> {
  const contract = requirePositional(ctx, 0, 'contract name', USAGE);
  const timeoutMs = intOption(ctx, 'timeout');
  const request: EmitRequest = {
    contract,
    payload: payloadOf(ctx),
    mode: flag(ctx, 'request') ? 'request' : 'emit',
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
  const base = await requireDevServer(requireRoot(ctx.cwd));
  const { status, body } = await postJson<EmitResponse | ErrorBody>(`${base}/api/emit`, request);

  if ('error' in body) {
    throw failure(status, body);
  }

  if (ctx.out.json) {
    ctx.out.emit({ kind: 'emit', ...body });
  } else {
    ctx.out.print(`traceId=${body.traceId}  envelopeId=${body.envelopeId}  ${body.durationMs}ms`);

    if (request.mode === 'request') {
      ctx.out.print(JSON.stringify(body.reply, null, 2));
    }
  }

  return EXIT.ok;
}

export const emitCommand: Command = {
  usage: USAGE,
  options: {
    payload: { type: 'string' },
    fixture: { type: 'string' },
    request: { type: 'boolean' },
    timeout: { type: 'string' },
  },
  run,
};
