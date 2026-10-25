import type { Frame, Snapshot } from '@murmur/dev-protocol';

export class FakeEventSource {
  static last: FakeEventSource | null = null;
  readonly listeners = new Map<string, ((event: MessageEvent<string>) => void)[]>();
  readonly url: string;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.last = this;
  }

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close(): void {
    this.listeners.clear();
  }

  emit(type: string, data: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: JSON.stringify(data) } as MessageEvent<string>);
    }
  }
}

export function helloFrame(snapshot: Snapshot): Extract<Frame, { frame: 'hello' }> {
  return { frame: 'hello', seq: 0, ts: 'x', protocol: 1, snapshot, replayFrom: null };
}
