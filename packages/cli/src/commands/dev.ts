import { spawn } from 'node:child_process';

import type { BootReport, Frame, Snapshot } from '@murmur/dev-protocol';

import { flag, intOption, stringOption, type Command, type CommandContext } from '../command.ts';
import { portHint } from '../dev/boot-failure.ts';
import { liveLock } from '../dev/lock.ts';
import { envFiles, payloadPolicy, processOption, portOption, traceDir } from '../dev/options.ts';
import { startSupervisor, type Ready, type Supervisor } from '../dev/supervisor.ts';
import { CliError, EXIT } from '../errors.ts';
import type { Output } from '../output.ts';
import { tailLine } from '../render/tail.ts';
import { requireRoot } from '../root.ts';

const USAGE =
  'dev [--port 4242] [--host 127.0.0.1] [--open] [--no-ui] [--no-watch] [--watch-tests] [--process <name>] [--replay 5000] [--redact] [--payload-cap 16kb] [--trace-dir .murmur/traces] [--inspect]';

const STOPPED = Symbol('stopped');

interface Console {
  live: boolean;
  handlers: Map<string, readonly string[]>;
}

function remember(view: Console, snapshot: Snapshot): void {
  view.handlers = new Map(snapshot.contracts.map((contract) => [contract.name, contract.handlers]));
}

function printer(out: Output, view: Console): (frame: Frame) => void {
  return (frame) => {
    if (frame.frame === 'dev.boot') {
      remember(view, frame.snapshot);
    }

    if (!view.live || out.quiet || frame.frame === 'ping') {
      return;
    }

    if (out.json) {
      out.stream(frame);

      return;
    }

    const line = tailLine(frame, {
      internal: false,
      failed: false,
      payload: false,
      handlers: (name) => view.handlers.get(name) ?? [],
    });

    if (line !== null) {
      out.print(line);
    }

    const hint = frame.frame === 'dev.boot_failed' ? portHint(frame.report) : null;
    if (hint !== null) {
      out.warn(hint);
    }
  };
}

function bootFailure(out: Output, report: BootReport | null): void {
  for (const error of report?.errors ?? []) {
    out.warn(`  [${error.phase}] ${error.message}`);
  }

  const hint = report === null ? null : portHint(report);
  if (hint !== null) {
    out.warn(hint);
  }
}

function banner(out: Output, supervisor: Supervisor, ready: Ready): void {
  const snapshot = ready !== null && 'app' in ready ? ready : null;
  const app = snapshot?.app.name ?? '—';
  const pieces = snapshot?.pieces.length ?? 0;

  if (out.json) {
    out.emit({ kind: 'dev', ok: snapshot !== null, app, pieces, url: supervisor.url, pid: process.pid });

    return;
  }

  out.print(`murmur dev  app=${app}  pieces=${pieces}  ui=${supervisor.url}  pid=${process.pid}`);

  if (snapshot !== null) {
    return;
  }

  out.warn('murmur dev: the app did not boot; watching for changes');
  bootFailure(out, ready !== null && 'errors' in ready ? ready : null);
}

const OPENERS = new Map<string, string>([
  ['darwin', 'open'],
  ['win32', 'start'],
]);

function openBrowser(url: string): void {
  const command = OPENERS.get(process.platform) ?? 'xdg-open';

  spawn(command, [url], { detached: true, stdio: 'ignore' })
    .on('error', () => {})
    .unref();
}

function untilSignal(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  process.once('SIGINT', () => resolve());
  process.once('SIGTERM', () => resolve());

  return promise;
}

function greet(ctx: CommandContext, view: Console, supervisor: Supervisor, ready: Ready): void {
  banner(ctx.out, supervisor, ready);
  view.live = true;

  if (flag(ctx, 'open') && ctx.values['ui'] !== false) {
    openBrowser(supervisor.url);
  }
}

async function assertNoLiveServer(root: string): Promise<void> {
  const lock = await liveLock(root);
  if (lock !== null) {
    throw new CliError(
      EXIT.internal,
      `murmur dev is already running for ${root} (pid ${lock.pid}, port ${lock.port})`,
      'stop it first, or use murmur tail / murmur emit against it',
    );
  }
}

async function run(ctx: CommandContext): Promise<number> {
  const root = requireRoot(ctx.cwd);
  await assertNoLiveServer(root);
  const view: Console = { live: false, handlers: new Map() };
  const stopped = untilSignal();

  const supervisor = await startSupervisor({
    root,
    host: stringOption(ctx, 'host') ?? '127.0.0.1',
    port: portOption(ctx),
    ui: ctx.values['ui'] !== false,
    watch: ctx.values['watch'] !== false,
    watchTests: flag(ctx, 'watch-tests'),
    process: processOption(ctx),
    replay: intOption(ctx, 'replay') ?? 5_000,
    payload: payloadPolicy(ctx),
    traceDir: traceDir(ctx, root),
    inspect: flag(ctx, 'inspect'),
    envFiles: envFiles(ctx),
    env: ctx.env,
    onFrame: printer(ctx.out, view),
    onLine: (line) => ctx.out.info(line),
  });

  const ready = await Promise.race([supervisor.ready, stopped.then((): typeof STOPPED => STOPPED)]);
  if (ready !== STOPPED) {
    greet(ctx, view, supervisor, ready);
  }

  await stopped;
  await supervisor.stop();

  return EXIT.ok;
}

export const devCommand: Command = {
  usage: USAGE,
  options: {
    port: { type: 'string' },
    host: { type: 'string' },
    open: { type: 'boolean' },
    ui: { type: 'boolean', default: true },
    watch: { type: 'boolean', default: true },
    'watch-tests': { type: 'boolean' },
    process: { type: 'string' },
    replay: { type: 'string' },
    redact: { type: 'boolean' },
    'payload-cap': { type: 'string' },
    'trace-dir': { type: 'string' },
    inspect: { type: 'boolean' },
  },
  run,
};
