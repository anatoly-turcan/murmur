import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import type { Frame } from '@murmur/dev-protocol';

import { fixtureApp, packageRoot, writeFiles } from './helpers.ts';

const CLI = join(packageRoot, 'bin', 'murmur.ts');

const SLOW_FILES: Readonly<Record<string, string>> = {
  'contracts/slow.ts': [
    "import { Event } from 'murmur'",
    "import { z } from 'zod'",
    '',
    "export class SlowRequested extends Event({ ms: z.number() }, { name: 'slow.requested' }) {}",
    '',
  ].join('\n'),
  'pieces/slow/context.md': '---\nsummary: Sleeps on request.\n---\n\n# slow\n',
  'pieces/slow/piece.ts': [
    "import { Handle, Piece } from 'murmur'",
    '',
    "import { SlowRequested } from '#contracts/slow'",
    '',
    'export class Slow extends Piece() {',
    '  @Handle(SlowRequested)',
    '  async sleep(event: SlowRequested): Promise<void> {',
    '    await new Promise((resolve) => setTimeout(resolve, event.ms))',
    '  }',
    '}',
    '',
  ].join('\n'),
};

export const STALL_PIECE = {
  'pieces/stall/context.md': '---\nsummary: Stalls at import.\n---\n\n# stall\n',
  'pieces/stall/piece.ts': [
    "import { Handle, Piece } from 'murmur'",
    '',
    "import { SlowRequested } from '#contracts/slow'",
    '',
    'await new Promise((resolve) => setTimeout(resolve, 6_000))',
    '',
    'export class Stall extends Piece() {',
    '  @Handle(SlowRequested)',
    '  async stall(): Promise<void> {}',
    '}',
    '',
  ].join('\n'),
};

export const HTTP_APP = {
  'capabilities/web/capability.ts': [
    "import { http } from '@murmur/node/capabilities'",
    '',
    'export default http()',
    '',
  ].join('\n'),
  'pieces/ping/context.md': '---\nsummary: Answers GET /ping.\n---\n\n# ping\n',
  'pieces/ping/piece.ts': [
    "import { Piece, Serve } from 'murmur'",
    '',
    "import web from '../../capabilities/web/capability.ts'",
    '',
    'export class Ping extends Piece() {',
    "  @Serve(web.get('/ping'))",
    '  async ping(): Promise<{ pong: boolean }> {',
    '    return { pong: true }',
    '  }',
    '}',
    '',
  ].join('\n'),
  'murmur.yaml': 'pieces:\n  todos/create:\n    prefix: fx\ncapabilities:\n  web:\n    port: ${PORT:-3000}\n',
};

export function bind(port: number): Promise<boolean> {
  const server = createServer();

  return new Promise((resolve) => {
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));

  return port;
}

export function killGroup(launched: Launched): void {
  if (launched.child.exitCode !== null || launched.child.signalCode !== null) {
    return;
  }

  try {
    process.kill(-(launched.child.pid as number), 'SIGKILL');
  } catch {}
}

export function copyFixtureApp(): { root: string; [Symbol.dispose](): void } {
  const root = mkdtempSync(join(tmpdir(), 'murmur-dev-'));
  cpSync(fixtureApp, root, { recursive: true });
  symlinkSync(join(packageRoot, 'node_modules'), join(root, 'node_modules'), 'dir');
  writeFiles(root, SLOW_FILES);

  return { root, [Symbol.dispose]: () => rmSync(root, { recursive: true, force: true }) };
}

export interface Launched {
  readonly child: ChildProcess;
  readonly exited: Promise<number | null>;
  output(): string;
}

export interface DevProcess extends Launched {
  readonly base: string;
}

export async function waitUntil<T>(
  probe: () => T | undefined | Promise<T | undefined>,
  ms = 15_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined) {
      return value;
    }

    await sleep(50);
  }

  throw new Error(`condition not met within ${ms} ms`);
}

function lockOf(root: string): { port: number; host: string } | undefined {
  const file = join(root, '.murmur', 'dev.json');
  if (!existsSync(file)) {
    return undefined;
  }

  try {
    return JSON.parse(readFileSync(file, 'utf8')) as { port: number; host: string };
  } catch {
    return undefined;
  }
}

export interface LaunchOptions {
  readonly detached?: boolean;
  readonly nodeArgs?: readonly string[];
}

export function launch(args: readonly string[], cwd: string, options: LaunchOptions = {}): Launched {
  const child = spawn(process.execPath, [...(options.nodeArgs ?? []), CLI, ...args], {
    cwd,
    env: { ...process.env, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: options.detached === true,
  });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));

  return { child, exited, output: () => output };
}

export async function startDev(
  root: string,
  args: readonly string[] = [],
  options: { detached?: boolean } = {},
): Promise<DevProcess> {
  const launched = launch(['dev', '--no-ui', '--port', '0', '--cwd', root, ...args], root, options);
  const lock = await waitUntil(() => lockOf(root));

  return { ...launched, base: `http://${lock.host}:${lock.port}` };
}

export async function getJson<T = Record<string, unknown>>(
  url: string,
): Promise<{ status: number; body: T }> {
  const response = await fetch(url);

  return { status: response.status, body: (await response.json()) as T };
}

export async function postJson<T = Record<string, unknown>>(
  url: string,
  body: unknown,
): Promise<{ status: number; body: T }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  return { status: response.status, body: (await response.json()) as T };
}

export interface FrameStream {
  readonly frames: Frame[];
  next<F extends Frame>(match: (frame: Frame) => frame is F, ms?: number): Promise<F>;
  next(match: (frame: Frame) => boolean, ms?: number): Promise<Frame>;
  close(): void;
}

function parseEvents(buffer: string, onFrame: (frame: Frame) => void): string {
  const blocks = buffer.split('\n\n');
  const rest = blocks.pop() ?? '';

  for (const block of blocks) {
    const data = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');

    if (data !== '') {
      onFrame(JSON.parse(data) as Frame);
    }
  }

  return rest;
}

export async function openEvents(url: string): Promise<FrameStream> {
  const controller = new AbortController();
  const response = await fetch(url, { signal: controller.signal });
  const frames: Frame[] = [];
  let cursor = 0;
  void (async () => {
    let buffer = '';

    if (response.body === null) {
      return;
    }

    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          return;
        }

        buffer = parseEvents(buffer + value, (frame) => frames.push(frame));
      }
    } catch {
      return;
    }
  })();

  const next = async (match: (frame: Frame) => boolean, ms = 15_000): Promise<Frame> =>
    waitUntil(() => {
      const index = frames.findIndex((frame, i) => i >= cursor && match(frame));
      if (index === -1) {
        return undefined;
      }

      cursor = index + 1;

      return frames[index];
    }, ms);

  return { frames, next: next as FrameStream['next'], close: () => controller.abort() };
}

export function cli(
  args: readonly string[],
  cwd: string,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [CLI, ...args], {
    cwd,
    env: { ...process.env, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));

  return new Promise((resolve) => child.once('exit', (status) => resolve({ status, stdout, stderr })));
}
