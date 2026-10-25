import { MurmurError, NonRetryableError, type SerializedError } from '../model/errors.ts';

export class CascadeDepthError extends NonRetryableError {
  override readonly name: string = 'CascadeDepthError';
  readonly contract: string;
  readonly hop: number;
  readonly maxHop: number;

  constructor(contract: string, hop: number, maxHop: number) {
    super(`${contract}: hop ${hop} exceeds maxHop ${maxHop}; a cascade of events is looping`, {
      code: 'cascade-depth',
    });
    this.contract = contract;
    this.hop = hop;
    this.maxHop = maxHop;
  }
}

export class NoHandlerError extends NonRetryableError {
  override readonly name: string = 'NoHandlerError';
  readonly piece: string;
  readonly contract: string;

  constructor(piece: string, contract: string) {
    super(`piece ${piece} received ${contract} but has no handler for it`, { code: 'no-handler' });
    this.piece = piece;
    this.contract = contract;
  }
}

export class PayloadTooLargeError extends NonRetryableError {
  override readonly name: string = 'PayloadTooLargeError';
  readonly contract: string;
  readonly bytes: number;
  readonly limit: number;

  constructor(contract: string, bytes: number, limit: number) {
    super(`${contract}: envelope is ${bytes} bytes, limit is ${limit}`, { code: 'payload-too-large' });
    this.contract = contract;
    this.bytes = bytes;
    this.limit = limit;
  }
}

export class EnvelopeShapeError extends NonRetryableError {
  override readonly name: string = 'EnvelopeShapeError';

  constructor(message: string) {
    super(message, { code: 'envelope-shape' });
  }
}

export class NoRouteError extends MurmurError {
  override readonly name: string = 'NoRouteError';
  readonly contract: string;

  constructor(contract: string) {
    super(`${contract}: no subscriber is bound to this name`, { code: 'no-route', retryable: false });
    this.contract = contract;
  }
}

export class RequestTimeoutError extends MurmurError {
  override readonly name: string = 'RequestTimeoutError';
  readonly contract: string;
  readonly correlationId: string;
  readonly elapsedMs: number;

  constructor(contract: string, correlationId: string, elapsedMs: number) {
    super(`${contract}: no reply after ${elapsedMs} ms (correlationId ${correlationId})`, {
      code: 'request-timeout',
      retryable: false,
    });
    this.contract = contract;
    this.correlationId = correlationId;
    this.elapsedMs = elapsedMs;
  }
}

export class RemoteError extends MurmurError {
  override readonly name: string = 'RemoteError';
  readonly contract: string;
  readonly remoteName: string;

  constructor(contract: string, remote: SerializedError) {
    super(remote.message, { code: remote.code ?? 'remote', retryable: remote.retryable ?? false });
    this.contract = contract;
    this.remoteName = remote.name;
  }
}

export class HandlerTimeoutError extends MurmurError {
  override readonly name: string = 'HandlerTimeoutError';
  readonly piece: string;
  readonly contract: string;
  readonly timeoutMs: number;

  constructor(piece: string, contract: string, timeoutMs: number) {
    super(`piece ${piece} did not finish ${contract} within ${timeoutMs} ms`, {
      code: 'handler-timeout',
      retryable: true,
    });
    this.piece = piece;
    this.contract = contract;
    this.timeoutMs = timeoutMs;
  }
}

export class ShutdownError extends MurmurError {
  override readonly name: string = 'ShutdownError';

  constructor(message: string) {
    super(message, { code: 'shutdown', retryable: true });
  }
}

export class DuplicateResponderError extends MurmurError {
  override readonly name: string = 'DuplicateResponderError';
  readonly contract: string;
  readonly pieces: readonly string[];

  constructor(contract: string, pieces: readonly string[]) {
    super(`${contract} has more than one responder: ${pieces.join(', ')}`, {
      code: 'duplicate-responder',
      retryable: false,
    });
    this.contract = contract;
    this.pieces = pieces;
  }
}

export class TransportError extends MurmurError {
  override readonly name: string = 'TransportError';

  constructor(message: string, options: { readonly retryable?: boolean; readonly cause?: unknown } = {}) {
    super(message, { code: 'transport', retryable: true, ...options });
  }
}
