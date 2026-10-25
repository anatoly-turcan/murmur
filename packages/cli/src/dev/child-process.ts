import { fork, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

import { devStopPolicy } from '@murmur/dev-protocol';

import { appExecArgv } from '../app-exec-argv.ts';
import { siblingModule } from '../sibling.ts';
import { existingEnvFiles } from './env-files.ts';
import type { CallFailure, ChildCall, ChildInit, ChildMessage, ParentMessage } from './ipc.ts';

const CHILD = siblingModule(import.meta, 'child');
const KILL_AFTER_MS = devStopPolicy.graceMs + devStopPolicy.forceMs + 1_000;

export interface ChildExit {
  readonly code: number | null;
  readonly signal: string | null;
}

export interface SpawnOptions {
  readonly root: string;
  readonly process: string | undefined;
  readonly envFiles: readonly string[];
  readonly inspect: boolean;
  readonly onMessage: (message: ChildMessage) => void;
  readonly onLine: (line: string) => void;
}

export interface ChildHandle {
  readonly pid: number | undefined;
  readonly exited: Promise<ChildExit>;
  call(call: ChildCall): Promise<unknown>;
  stop(): Promise<ChildExit>;
}

export class CallError extends Error {
  override readonly name = 'CallError';
  readonly failure: CallFailure;

  constructor(failure: CallFailure) {
    super(failure.error.message);
    this.failure = failure;
  }
}

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: CallError) => void;
}

function execArgv(options: SpawnOptions): string[] {
  const envFiles = existingEnvFiles(options.root, options.envFiles);

  return [
    ...appExecArgv(options.root),
    ...envFiles.map((file) => `--env-file=${file}`),
    ...(options.inspect ? ['--inspect'] : []),
  ];
}

function pipeLines(child: ChildProcess, onLine: (line: string) => void): void {
  for (const stream of [child.stdout, child.stderr]) {
    if (stream !== null) {
      createInterface({ input: stream }).on('line', onLine);
    }
  }
}

function settleReply(pending: Map<number, Pending>, message: ChildMessage): boolean {
  if (message.t !== 'reply') {
    return false;
  }

  const entry = pending.get(message.id);
  pending.delete(message.id);

  if (message.ok) {
    entry?.resolve(message.value);
  } else {
    entry?.reject(new CallError({ status: message.status, error: message.error }));
  }

  return true;
}

function stopper(child: ChildProcess, exited: Promise<ChildExit>): () => Promise<ChildExit> {
  return async () => {
    if (child.exitCode !== null || child.signalCode !== null) {
      return exited;
    }

    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), KILL_AFTER_MS);

    try {
      return await exited;
    } finally {
      clearTimeout(timer);
    }
  };
}

export function spawnChild(options: SpawnOptions): ChildHandle {
  const init: ChildInit = { root: options.root, process: options.process };
  const child = fork(CHILD, [JSON.stringify(init)], {
    cwd: options.root,
    execArgv: execArgv(options),
    serialization: 'advanced',
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const pending = new Map<number, Pending>();
  let nextId = 1;
  pipeLines(child, options.onLine);
  child.on('message', (message: ChildMessage) => {
    if (!settleReply(pending, message)) {
      options.onMessage(message);
    }
  });
  const exited = new Promise<ChildExit>((settle) => {
    child.once('close', (code, signal) => {
      for (const entry of pending.values()) {
        entry.reject(
          new CallError({ status: 503, error: { name: 'AppDownError', message: 'the app process exited' } }),
        );
      }

      pending.clear();
      settle({ code, signal });
    });
  });

  return {
    pid: child.pid,
    exited,
    call: (call) => {
      const id = nextId++;
      const { promise, resolve, reject } = Promise.withResolvers<unknown>();
      pending.set(id, { resolve, reject });
      const message: ParentMessage = { t: 'call', id, call };
      if (child.connected) {
        child.send(message);
      } else {
        reject(
          new CallError({ status: 503, error: { name: 'AppDownError', message: 'the app process exited' } }),
        );
      }

      return promise;
    },
    stop: stopper(child, exited),
  };
}
