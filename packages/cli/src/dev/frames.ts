import type { Frame } from '@murmur/dev-protocol';

type FrameBody = Frame extends infer F ? (F extends Frame ? Omit<F, 'seq' | 'ts'> : never) : never;

export interface FrameSequence {
  publish(body: FrameBody): Frame;
  last(): number;
}

export function createFrames(onFrame: (frame: Frame) => void): FrameSequence {
  let seq = 0;

  return {
    publish: (body) => {
      seq += 1;
      const frame = { ...body, seq, ts: new Date().toISOString() } as Frame;
      onFrame(frame);

      return frame;
    },
    last: () => seq,
  };
}
