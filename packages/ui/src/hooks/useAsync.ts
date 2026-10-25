import { useEffect, useState } from 'react';

export type AsyncState<T> =
  | { status: 'loading' }
  | { status: 'ok'; value: T }
  | { status: 'error'; error: string };

export function useAsync<T>(load: () => Promise<T>, deps: readonly unknown[]): AsyncState<T> {
  const [state, setState] = useState<AsyncState<T>>({ status: 'loading' });
  useEffect(() => {
    let live = true;
    setState((s) => (s.status === 'ok' ? s : { status: 'loading' }));
    load().then(
      (value) => live && setState({ status: 'ok', value }),
      (error: unknown) =>
        live && setState({ status: 'error', error: error instanceof Error ? error.message : String(error) }),
    );

    return () => {
      live = false;
    };
  }, deps);

  return state;
}
