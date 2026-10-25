import { randomBytes } from 'node:crypto';
import { adapt } from './cr-adapter.ts';
import { RUN_TOKEN } from './env.ts';
import { nextIp, send, type ApiResponse, type Json, type Query, type RequestOptions } from './http.ts';

export { buildUrl, nextIp, quoted } from './http.ts';
export type { ApiResponse, Json, Query, QueryValue, RequestOptions } from './http.ts';

let keyCounter = 0;

export function idempotencyKey(label = 'k'): string {
  keyCounter += 1;

  return `${label}-${RUN_TOKEN}-${keyCounter}-${randomBytes(3).toString('hex')}`;
}

export function etagVersion(res: ApiResponse): number | null {
  const raw = res.headers.get('etag');
  const match = raw?.match(/^"(\d+)"$/);

  return match ? Number(match[1]) : null;
}

export function request(method: string, path: string, opts: RequestOptions = {}): Promise<ApiResponse> {
  return opts.raw ? send(method, path, opts) : adapt(method, path, opts);
}

export class Client {
  readonly key: string | null;
  readonly ip: string;

  constructor(key: string | null, ip: string = nextIp()) {
    this.key = key;
    this.ip = ip;
  }

  request(method: string, path: string, opts: RequestOptions = {}): Promise<ApiResponse> {
    return request(method, path, { key: this.key, ip: this.ip, ...opts });
  }

  get(path: string, query?: Query, opts: RequestOptions = {}): Promise<ApiResponse> {
    return this.request('GET', path, { ...opts, query });
  }

  post(path: string, body?: unknown, opts: RequestOptions = {}): Promise<ApiResponse> {
    return this.request('POST', path, { ...opts, body });
  }

  put(path: string, body?: unknown, opts: RequestOptions = {}): Promise<ApiResponse> {
    return this.request('PUT', path, { ...opts, body });
  }

  patch(path: string, body: unknown, opts: RequestOptions = {}): Promise<ApiResponse> {
    return this.request('PATCH', path, { ...opts, body });
  }

  delete(path: string, opts: RequestOptions = {}): Promise<ApiResponse> {
    return this.request('DELETE', path, opts);
  }

  async pageAll(path: string, query: Query = {}, maxPages = 500): Promise<{ items: Json[]; pages: ApiResponse[] }> {
    const items: Json[] = [];
    const pages: ApiResponse[] = [];
    let cursor: string | null = null;
    do {
      const res = await this.get(path, cursor ? { ...query, cursor } : query);
      if (res.status !== 200) throw new Error(`pager: GET ${res.url} → ${res.status} ${res.text.slice(0, 300)}`);
      pages.push(res);
      items.push(...res.body.data);
      cursor = res.body.next_cursor;
      if (pages.length > maxPages) throw new Error(`pager: more than ${maxPages} pages for ${path}`);
    } while (cursor);

    return { items, pages };
  }
}

export function anonymous(ip?: string): Client {
  return new Client(null, ip);
}
