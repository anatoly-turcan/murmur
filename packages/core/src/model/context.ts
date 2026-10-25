export interface RunContext {
  readonly traceId: string;
  readonly eventId?: string;
  readonly hop: number;
  readonly piece: string;
  readonly deliveryId?: string;
  readonly attempt?: number;
  readonly signal: AbortSignal;
  readonly deadline?: string;
  readonly internal: boolean;
  readonly request?: { correlationId: string; replyTo: string; replyAddress?: string };
}

export interface EnterInit {
  piece: string;
  traceId?: string;
  signal?: AbortSignal;
}
