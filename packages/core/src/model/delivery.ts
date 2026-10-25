import type { Envelope } from './envelope.ts';

export interface Delivery {
  readonly envelope: Envelope;
  readonly attempt: number;
  readonly signal: AbortSignal;
  readonly piece: string;
}
