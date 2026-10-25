import type { DotTone } from '../components/StatusDot.tsx';
import type { UiState } from '../store/state.ts';

export function liveStatus(state: Pick<UiState, 'connection' | 'phase'>): { tone: DotTone; label: string } {
  if (state.phase === 'boot-failed') {
    return { tone: 'fail', label: 'boot failed' };
  }

  if (state.connection !== 'live') {
    return { tone: 'warn', label: state.connection === 'connecting' ? 'connecting' : 'reconnecting' };
  }

  if (state.phase === 'restarting') {
    return { tone: 'accent', label: 'restarting' };
  }

  return { tone: 'ok', label: 'live' };
}
