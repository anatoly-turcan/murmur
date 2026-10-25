import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { appRootFrom } from './target.ts';

type Snapshot = Readonly<Record<string, string>>;
type SnapshotKind = 'baseline' | 'seen';

function git(cwd: string, args: readonly string[]): string | null {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });

  return result.status === 0 ? result.stdout : null;
}

function porcelainPaths(output: string): string[] {
  const fields = output.split('\0').filter((field) => field !== '');
  const paths: string[] = [];

  for (let at = 0; at < fields.length; at++) {
    const field = fields[at] ?? '';
    paths.push(field.slice(3));

    if (field.startsWith('R') || field.startsWith('C')) {
      at++;
    }
  }

  return paths;
}

export function repoTop(cwd: string): string | null {
  return git(cwd, ['rev-parse', '--show-toplevel'])?.trim() ?? null;
}

export function hasMurmurApp(top: string): boolean {
  const output = git(top, ['ls-files', '--', '*murmur.config.ts']);

  return output !== null && output.trim() !== '';
}

export function inMurmurRepo(cwd: string, top: string | null): boolean {
  return appRootFrom(cwd) !== null || (top !== null && hasMurmurApp(top));
}

export function dirtyFiles(top: string): string[] {
  const output = git(top, ['status', '--porcelain', '-z', '--untracked-files=all']);

  return output === null ? [] : porcelainPaths(output).map((path) => join(top, path));
}

function signature(file: string): string {
  if (!existsSync(file)) {
    return 'deleted';
  }

  const stats = statSync(file);

  return `${stats.mtimeMs}:${stats.size}`;
}

function snapshotOf(files: readonly string[]): Snapshot {
  return Object.fromEntries(files.map((file) => [file, signature(file)]));
}

function snapshotFile(top: string, session: string, kind: SnapshotKind): string {
  const dir = join(tmpdir(), 'murmur-hook');
  const name = createHash('sha256').update(`${top}\0${session}`).digest('hex').slice(0, 24);
  mkdirSync(dir, { recursive: true });

  return join(dir, `${name}.${kind}.json`);
}

function readSnapshot(file: string): Snapshot {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Snapshot;
  } catch {
    return {};
  }
}

function writeSnapshot(file: string, snapshot: Snapshot): void {
  writeFileSync(file, JSON.stringify(snapshot));
}

function changedPaths(previous: Snapshot, current: Snapshot): string[] {
  return Object.keys(current).filter((path) => previous[path] !== current[path]);
}

export function recordBaseline(top: string, session: string): void {
  const baseline = snapshotOf(dirtyFiles(top));
  writeSnapshot(snapshotFile(top, session, 'baseline'), baseline);
  writeSnapshot(snapshotFile(top, session, 'seen'), baseline);
}

export function changedSinceLastLook(top: string, session: string): string[] {
  const file = snapshotFile(top, session, 'seen');
  const current = snapshotOf(dirtyFiles(top));
  const changed = changedPaths(readSnapshot(file), current);
  writeSnapshot(file, current);

  return changed;
}

export function changedSinceBaseline(top: string, session: string): string[] {
  return changedPaths(readSnapshot(snapshotFile(top, session, 'baseline')), snapshotOf(dirtyFiles(top)));
}

export function markSeen(top: string, session: string, files: readonly string[]): void {
  const file = snapshotFile(top, session, 'seen');
  writeSnapshot(file, { ...readSnapshot(file), ...snapshotOf(files) });
}
