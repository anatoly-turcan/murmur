import { existsSync, readFileSync, statSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const MISSING_UI = [
  '<!doctype html><meta charset="utf-8"><title>murmur dev</title>',
  '<body style="font-family:system-ui;margin:2rem">',
  '<h1>murmur dev</h1><p>The UI is not built. Run <code>pnpm build:ui</code> in the murmur repo, then reload.</p>',
  '<p>The dev protocol is live under <a href="/api/health">/api</a>.</p></body>',
].join('');

function packageDir(file: string): string | null {
  for (let dir = dirname(file); dir !== dirname(dir); dir = dirname(dir)) {
    if (existsSync(join(dir, 'package.json'))) {
      return dir;
    }
  }

  return null;
}

export function resolveUiDist(): string | null {
  try {
    const entry = fileURLToPath(import.meta.resolve('@murmur/ui'));
    const dir = entry.endsWith('index.html') ? dirname(entry) : join(packageDir(entry) ?? '', 'dist');

    return existsSync(join(dir, 'index.html')) ? dir : null;
  } catch {
    return null;
  }
}

function decoded(pathname: string): string | null {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return null;
  }
}

function fileFor(dist: string, pathname: string): string {
  const candidate = join(dist, normalize(pathname).replace(/^(\.\.[/\\])+/, ''));
  const inside = candidate.startsWith(dist) && existsSync(candidate) && statSync(candidate).isFile();

  return inside ? candidate : join(dist, 'index.html');
}

export function serveUi(res: ServerResponse, dist: string | null, pathname: string): void {
  if (dist === null) {
    res.writeHead(200, { 'content-type': TYPES['.html'] as string }).end(MISSING_UI);

    return;
  }

  const path = decoded(pathname);
  if (path === null) {
    res.writeHead(400, { 'content-type': 'text/plain' }).end('malformed URL escape');

    return;
  }

  const file = fileFor(dist, path);
  res
    .writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
    .end(readFileSync(file));
}
