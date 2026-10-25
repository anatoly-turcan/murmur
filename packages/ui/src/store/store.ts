import type { Frame, StoredEnvelope } from '@murmur/dev-protocol';
import { createContext, useContext, useMemo, useSyncExternalStore } from 'react';

import {
  connectionChanged,
  initialState,
  missedCleared,
  reduce,
  type ConnectionStatus,
  type UiState,
} from './state.ts';

type Listener = () => void;
type EnvListener = (stored: StoredEnvelope) => void;

export interface Store {
  getState: () => UiState;
  subscribe: (listener: Listener) => () => void;
  onEnvelope: (listener: EnvListener) => () => void;
  dispatch: (frame: Frame) => void;
  setConnection: (status: ConnectionStatus) => void;
  clearMissed: () => void;
}

const NOTIFY_MS = 50;

export function createStore(state: UiState = initialState()): Store {
  const listeners = new Set<Listener>();
  const envListeners = new Set<EnvListener>();
  let pending = false;

  const notify = (): void => {
    if (pending) {
      return;
    }

    pending = true;
    setTimeout(() => {
      pending = false;

      for (const listener of listeners) {
        listener();
      }
    }, NOTIFY_MS);
  };
  const set = (next: UiState): void => {
    if (next === state) {
      return;
    }

    state = next;
    notify();
  };

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);

      return () => listeners.delete(listener);
    },
    onEnvelope: (listener) => {
      envListeners.add(listener);

      return () => envListeners.delete(listener);
    },
    dispatch: (frame) => {
      const before = state.lastEnv;
      set(reduce(state, frame));

      if (state.lastEnv && state.lastEnv !== before) {
        for (const l of envListeners) {
          l(state.lastEnv);
        }
      }
    },
    setConnection: (status) => set(connectionChanged(state, status)),
    clearMissed: () => set(missedCleared(state)),
  };
}

export const StoreContext = createContext<Store | null>(null);

export function useStore(): Store {
  const store = useContext(StoreContext);
  if (!store) {
    throw new Error('StoreContext missing');
  }

  return store;
}

export function useUi<T>(selector: (state: UiState) => T): T {
  const store = useStore();
  const state = useSyncExternalStore(store.subscribe, store.getState);

  return useMemo(() => selector(state), [state, selector]);
}

export function memoByVersion<T>(compute: (state: UiState) => T): (state: UiState) => T {
  let version = -1;
  let ring: unknown = null;
  let value: T;

  return (state) => {
    if (state.version !== version || state.ring !== ring) {
      version = state.version;
      ring = state.ring;
      value = compute(state);
    }

    return value;
  };
}
