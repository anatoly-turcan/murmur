import { useCallback, useEffect, useState } from 'react';

import { readLocal, writeLocal } from '../store/local.ts';

export type Theme = 'light' | 'dark';

const KEY = 'murmur.theme';

function systemTheme(): Theme {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

export function initialTheme(): Theme {
  const stored = readLocal(KEY);

  return stored === 'dark' || stored === 'light' ? stored : systemTheme();
}

export function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle('dark', theme === 'dark');
}

export function useTheme(): { theme: Theme; toggle: () => void } {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  useEffect(() => applyTheme(theme), [theme]);
  const toggle = useCallback(() => {
    setTheme((current) => {
      const next = current === 'dark' ? 'light' : 'dark';
      writeLocal(KEY, next);

      return next;
    });
  }, []);

  return { theme, toggle };
}
