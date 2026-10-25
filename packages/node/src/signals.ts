const SIGNALS = ['SIGINT', 'SIGTERM'] as const;

export function installSignals(stop: (reason: string) => unknown): () => void {
  let stopping = false;
  const handlers = SIGNALS.map((signal) => {
    const handler = () => {
      if (stopping) {
        return;
      }

      stopping = true;
      stop(signal);
    };
    process.on(signal, handler);

    return () => process.off(signal, handler);
  });

  return () => {
    for (const remove of handlers) {
      remove();
    }
  };
}
