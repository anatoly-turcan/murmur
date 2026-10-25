export interface Envelope<P = unknown> {
  readonly id: string;
  readonly name: string;
  readonly traceId: string;
  readonly causationId?: string;
  readonly correlationId?: string;
  readonly replyTo?: string;
  readonly deadline?: string;
  readonly ts: string;
  readonly hop: number;
  readonly source?: string;
  readonly payload: P;
}
