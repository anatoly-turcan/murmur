import { fork, type ChildProcess } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { appExecArgv } from '../app-exec-argv.ts';
import { siblingModule } from '../sibling.ts';
import type { DescribeInput } from './describe-worker.ts';
import { pieceNodes } from './discover.ts';
import type { Repo, RepoDescription } from './types.ts';

const CACHE_MS = 5_000;
const WORKER = siblingModule(import.meta, 'describe-worker');

type WorkerReply = { ok: true; description: RepoDescription } | { ok: false; error: string };

interface CacheEntry {
  readonly key: string;
  readonly at: number;
  readonly description: RepoDescription;
}

export interface DescribeOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly skipPieces?: ReadonlySet<string>;
}

const cache = new Map<string, CacheEntry>();

export class DescribeError extends Error {
  override readonly name = 'DescribeError';
}

function inputOf(repo: Repo, skip: ReadonlySet<string>): DescribeInput {
  return {
    root: repo.root,
    pieces: pieceNodes(repo)
      .filter((node) => !skip.has(node.id))
      .map((node) => ({ id: node.id, file: node.pieceFile as string })),
    contractFiles: repo.contractFiles,
    capabilityFiles: repo.capabilityFiles,
  };
}

function watchedFiles(repo: Repo): string[] {
  const inFolders = [...repo.folders.values()].flatMap((node) =>
    node.files.filter((f) => f.endsWith('.ts')).map((f) => join(node.dir, f)),
  );

  return [
    join(repo.root, 'murmur.config.ts'),
    ...repo.contractFiles.map((c) => c.file),
    ...repo.capabilityFiles,
    ...inFolders,
  ];
}

function cacheKey(repo: Repo): string {
  return watchedFiles(repo)
    .map((file) => {
      if (!existsSync(file)) {
        return `${file}:-`;
      }

      const stat = statSync(file);

      return `${file}:${stat.mtimeMs}:${stat.size}`;
    })
    .join('|');
}

function killAfter(child: ChildProcess, timeoutMs: number | undefined, fail: (error: Error) => void): void {
  if (timeoutMs === undefined) {
    return;
  }

  const timer = setTimeout(() => {
    fail(new DescribeError(`describe worker timed out after ${timeoutMs} ms`));
    child.kill('SIGKILL');
  }, timeoutMs);
  child.once('exit', () => clearTimeout(timer));
}

function killOnAbort(
  child: ChildProcess,
  signal: AbortSignal | undefined,
  fail: (error: Error) => void,
): void {
  if (signal === undefined) {
    return;
  }

  const abort = () => {
    fail(new DescribeError('describe worker aborted', { cause: signal.reason }));
    child.kill('SIGKILL');
  };

  if (signal.aborted) {
    abort();
  } else {
    signal.addEventListener('abort', abort, { once: true });
  }

  child.once('exit', () => signal.removeEventListener('abort', abort));
}

function runWorker(input: DescribeInput, options: DescribeOptions): Promise<RepoDescription> {
  const { promise, resolve, reject } = Promise.withResolvers<RepoDescription>();
  const child = fork(WORKER, [], {
    cwd: input.root,
    execArgv: appExecArgv(input.root),
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    serialization: 'advanced',
  });
  killAfter(child, options.timeoutMs, reject);
  killOnAbort(child, options.signal, reject);
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  child.stdout?.resume();
  child.once('message', (reply: WorkerReply) => {
    if (reply.ok) {
      resolve(reply.description);
    } else {
      reject(new DescribeError(reply.error));
    }
  });
  child.once('exit', (code) =>
    reject(new DescribeError(`describe worker exited with ${code}: ${stderr.trim()}`)),
  );
  child.once('error', reject);
  child.send(input);

  return promise;
}

export async function describe(repo: Repo, options: DescribeOptions = {}): Promise<RepoDescription> {
  const key = cacheKey(repo);
  const hit = cache.get(repo.root);

  if (hit !== undefined && hit.key === key && Date.now() - hit.at < CACHE_MS) {
    return hit.description;
  }

  const description = await runWorker(inputOf(repo, options.skipPieces ?? new Set()), options);
  cache.set(repo.root, { key, at: Date.now(), description });

  return description;
}
