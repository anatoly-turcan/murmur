export interface Binding {
  keys: string;
  description: string;
  scope: 'global' | 'tree' | 'flock' | 'events' | 'traces' | 'piece';
}

export const BINDINGS: readonly Binding[] = [
  { keys: '1-4', description: 'Flock, Events, Traces, Catalog', scope: 'global' },
  { keys: 'g f / g e / g t / g c', description: 'go to Flock / Events / Traces / Catalog', scope: 'global' },
  { keys: '⌘K or /', description: 'command palette', scope: 'global' },
  { keys: '?', description: 'this sheet', scope: 'global' },
  { keys: 'Esc', description: 'close drawer, palette or sheet', scope: 'global' },
  { keys: '[ / ]', description: 'narrow / widen the drawer', scope: 'global' },
  { keys: 'j / k', description: 'move in the tree', scope: 'tree' },
  { keys: 'h / l', description: 'collapse / expand', scope: 'tree' },
  { keys: 'Enter', description: 'open the selected tree row', scope: 'tree' },
  { keys: '0 / f', description: 'reset zoom / fit', scope: 'flock' },
  { keys: 'l', description: 'expand the selected group', scope: 'flock' },
  { keys: 't', description: 'open the trace of the selected row', scope: 'events' },
  { keys: '← / →', description: 'collapse / expand the selected span', scope: 'traces' },
  { keys: 'l', description: 'interleave log lines', scope: 'traces' },
  { keys: '1-6', description: 'piece tabs', scope: 'piece' },
];
