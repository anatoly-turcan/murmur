import type { UiState } from '../store/state.ts';
import { useUi } from '../store/store.ts';

const identity = (state: UiState) => state;

export function useUiState(): UiState {
  return useUi(identity);
}
