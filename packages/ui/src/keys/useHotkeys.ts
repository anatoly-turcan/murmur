import { useEffect, useRef } from 'react';

export type HotkeyMap = Record<string, (event: KeyboardEvent) => void>;

const SEQUENCE_MS = 800;

export function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

export function keyName(event: KeyboardEvent): string {
  const mod = event.metaKey || event.ctrlKey ? 'mod+' : '';

  return `${mod}${event.key}`;
}

export function useHotkeys(map: HotkeyMap, enabled = true): void {
  const mapRef = useRef(map);
  mapRef.current = map;
  useEffect(() => {
    if (!enabled) {
      return;
    }

    let prefix = '';
    let prefixAt = 0;
    const onKey = (event: KeyboardEvent): void => {
      const key = keyName(event);
      if (isTyping(event.target) && key !== 'Escape' && key !== 'mod+k') {
        return;
      }

      const fresh = Date.now() - prefixAt < SEQUENCE_MS ? prefix : '';
      const handler = mapRef.current[fresh ? `${fresh} ${key}` : key];
      prefix = '';

      if (handler) {
        event.preventDefault();
        handler(event);
      } else if (Object.keys(mapRef.current).some((k) => k.startsWith(`${key} `))) {
        prefix = key;
        prefixAt = Date.now();
      }
    };
    window.addEventListener('keydown', onKey);

    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}
