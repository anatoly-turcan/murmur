import type { TreeNode } from '@murmur/dev-protocol';
import { createContext, useContext } from 'react';

export type DrawerCard =
  | { kind: 'piece'; id: string }
  | { kind: 'event'; seq: number }
  | { kind: 'contract'; name: string };

export type ToastKind = 'info' | 'error';

export interface Shell {
  drawer: DrawerCard | null;
  openDrawer: (card: DrawerCard) => void;
  closeDrawer: () => void;
  toast: (message: string, kind?: ToastKind) => void;
  tree: TreeNode[];
  expanded: ReadonlySet<string>;
  toggleExpanded: (id: string, open?: boolean) => void;
  openPalette: () => void;
}

export const ShellContext = createContext<Shell | null>(null);

export function useShell(): Shell {
  const shell = useContext(ShellContext);
  if (!shell) {
    throw new Error('ShellContext missing');
  }

  return shell;
}
