import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { MurmurError, type Clock, type Envelope, type PublishOptions } from 'murmur';

import type { HttpServer } from '../capabilities/http/server.ts';
import type { Jobs, Sqlite } from '../capabilities/types.ts';
import type { Env } from '../config/sources.ts';
import { createRuntime } from '../runtime.ts';
import { inSequence } from '../sequence.ts';
import type { Runtime } from '../types.ts';
import { callerRoot } from './app-root.ts';

export interface TestAppOptions {
  readonly root?: string;
  readonly process?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly tap?: (envelope: Envelope, options: PublishOptions | undefined) => void;
}

export interface TestApp extends AsyncDisposable {
  readonly runtime: Runtime;
  readonly url: string;
  readonly db: Sqlite;
  readonly clock: Clock;
  readonly jobs: Jobs;
  fetch(path: string, init?: RequestInit): Promise<Response>;
  reset(): Promise<void>;
  stop(): Promise<void>;
}

const PORT_KEY = /^MURMUR__CAP_[A-Z0-9_]+__PORT$/;
const FRAMEWORK_STATE = new Set(['murmur_jobs', 'murmur_schedules', 'murmur_idempotency', 'murmur_kv']);

function testEnv(file: string, given: Readonly<Record<string, string>>): Env {
  const base: Record<string, string | undefined> = {
    ...process.env,
    MURMUR_LOG_LEVEL: 'error',
    MURMUR__CAP_SQLITE__PATH: file,
    MURMUR__CAP_CLOCK__OVERRIDABLE: 'true',
    MURMUR__CAP_JOBS__POLL: 'false',
    ...given,
  };

  return new Proxy(base, {
    get: (target, key) => {
      if (typeof key === 'string' && PORT_KEY.test(key) && !(key in given)) {
        return '0';
      }

      return Reflect.get(target, key);
    },
  });
}

function capability<T>(runtime: Runtime, name: string, hint: string): T {
  const handle = runtime.capabilities.get(name);
  if (handle === undefined) {
    throw new MurmurError(`createTestApp: the app runs no ${name} capability; ${hint}`, {
      code: 'test-app-no-capability',
      retryable: false,
    });
  }

  return handle as T;
}

function isHttpServer(value: unknown): value is HttpServer {
  return typeof value === 'object' && value !== null && Reflect.get(value, 'brand') === 'murmur.http';
}

function urlOf(runtime: Runtime): string {
  const server = [...runtime.capabilities.values()].find(isHttpServer);
  if (server === undefined) {
    throw new MurmurError(
      'createTestApp: no http capability is listening; serve a route from an edge piece (@Serve(web.get(…)))',
      { code: 'test-app-no-capability', retryable: false },
    );
  }

  return server.url;
}

async function truncate(db: Sqlite): Promise<void> {
  await db.transaction(async (tx) => {
    const tables = await tx.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'",
    );

    const cleared = tables
      .map((table) => table.name)
      .filter((name) => !name.startsWith('murmur_') || FRAMEWORK_STATE.has(name));

    await tx.exec('PRAGMA defer_foreign_keys = ON');
    await inSequence(cleared, (name) => tx.run(`DELETE FROM "${name.replaceAll('"', '""')}"`));
  });
}

function testAppOf(runtime: Runtime, dir: string): TestApp {
  const db = () => capability<Sqlite>(runtime, 'sqlite', 'a piece needs sqlite for the app database');
  const stop = async () => {
    await runtime.stop('test');
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  };

  return {
    runtime,
    get url() {
      return urlOf(runtime);
    },
    get db() {
      return db();
    },
    clock: runtime.clock,
    get jobs() {
      return capability<Jobs>(runtime, 'jobs', 'a piece declares needs: { jobs } or an every handler');
    },
    fetch: (path, init) => globalThis.fetch(new URL(path, urlOf(runtime)), init),
    reset: async () => {
      await truncate(db());
      await runtime.clock.clear();
    },
    stop,
    [Symbol.asyncDispose]: stop,
  };
}

async function started(runtime: Runtime): Promise<Runtime> {
  try {
    await runtime.start();
  } catch (error) {
    await runtime.stop('test start failed');
    throw error;
  }

  return runtime;
}

export async function createTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const root = resolve(options.root ?? callerRoot());
  const dir = await mkdtemp(join(tmpdir(), 'murmur-test-app-'));

  try {
    const runtime = await createRuntime({
      root,
      mode: 'dev',
      signals: false,
      env: testEnv(join(dir, 'app.db'), options.env ?? {}),
      ...(options.process === undefined ? {} : { process: options.process }),
      ...(options.tap === undefined ? {} : { tap: options.tap }),
    });

    return testAppOf(await started(runtime), dir);
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}
