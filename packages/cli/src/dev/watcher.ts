import { existsSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';

const DEBOUNCE_MS = 80;
const TREES = ['pieces', 'contracts', 'capabilities'];
const ROOT_FILES = new Set(['murmur.config.ts', 'murmur.yaml']);
const IGNORED_SEGMENTS = new Set(['.murmur', 'node_modules', 'dist']);

export interface WatchOptions {
  readonly root: string;
  readonly watchTests: boolean;
  readonly onChange: (paths: string[]) => void;
}

function isWatched(path: string, watchTests: boolean): boolean {
  const segments = path.split('/');
  if (segments.some((segment) => IGNORED_SEGMENTS.has(segment))) {
    return false;
  }

  if (!watchTests && path.endsWith('.test.ts')) {
    return false;
  }

  if (segments.length === 1) {
    return ROOT_FILES.has(path) || path.startsWith('.env');
  }

  return TREES.includes(segments[0] as string);
}

function debounced(onChange: (paths: string[]) => void): (path: string) => void {
  const pending = new Set<string>();
  let timer: NodeJS.Timeout | undefined;

  return (path) => {
    pending.add(path);
    clearTimeout(timer);
    timer = setTimeout(() => {
      const paths = [...pending].toSorted();
      pending.clear();
      onChange(paths);
    }, DEBOUNCE_MS);
  };
}

function watchTree(root: string, tree: string, notify: (path: string) => void): FSWatcher | null {
  const dir = join(root, tree);
  if (!existsSync(dir)) {
    return null;
  }

  return watch(dir, { recursive: true }, (_event, file) => {
    if (file !== null) {
      notify(`${tree}/${file.split('\\').join('/')}`);
    }
  });
}

export function startWatcher(options: WatchOptions): { close(): void } {
  const push = debounced(options.onChange);
  const notify = (path: string) => {
    if (isWatched(path, options.watchTests)) {
      push(path);
    }
  };
  const watchers = [
    ...TREES.map((tree) => watchTree(options.root, tree, notify)),
    watch(options.root, (_event, file) => {
      if (file !== null) {
        notify(file);
      }
    }),
  ].filter((watcher) => watcher !== null);

  return {
    close: () => {
      for (const watcher of watchers) {
        watcher.close();
      }
    },
  };
}
