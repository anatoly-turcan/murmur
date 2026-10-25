import type { PieceView } from './catalog.ts';
import type { LogLine, StoredEnvelope } from './trace.ts';

export interface HealthResponse {
  ok: true;
  protocol: 1;
  app: string;
  pid: number;
  startedAt: string;
  pieces: number;
  uptimeMs: number;
}

export interface EnvelopesPage {
  items: StoredEnvelope[];
  nextBefore: number | null;
}

export interface PieceDetail extends PieceView {
  contextMd: string | null;
  files: { path: string; bytes: number }[];
  recent: StoredEnvelope[];
  logs: LogLine[];
}

export interface ContextSection {
  id: string;
  title: string;
  tokens: number;
  level: number;
  truncated: boolean;
}

export interface ContextResponse {
  markdown: string;
  sections: ContextSection[];
  tokens: number;
  budget: number | null;
  overBudget: boolean;
  sizing: 'ok' | 'large' | 'warn' | 'fail';
}

export interface ContractSchemaResponse {
  name: string;
  hasReply: boolean;
  payload: unknown;
  reply?: unknown;
}

export interface EmitRequest {
  contract: string;
  payload: unknown;
  mode: 'emit' | 'request';
  timeoutMs?: number;
}

export interface EmitResponse {
  traceId: string;
  envelopeId: string;
  reply?: unknown;
  durationMs: number;
}

export interface LogsResponse {
  items: LogLine[];
}
