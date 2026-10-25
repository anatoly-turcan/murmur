import type { WorkspacePackage } from './manifest.ts';

function runtimeDeps(pkg: WorkspacePackage): string[] {
  return Object.keys({ ...pkg.manifest.dependencies, ...pkg.manifest.peerDependencies });
}

export function publishOrder(packages: readonly WorkspacePackage[]): WorkspacePackage[] {
  const byName = new Map(packages.map((pkg) => [pkg.manifest.name, pkg]));
  const ordered: WorkspacePackage[] = [];
  const state = new Map<string, 'visiting' | 'done'>();

  const visit = (pkg: WorkspacePackage, path: readonly string[]): void => {
    const name = pkg.manifest.name;
    if (state.get(name) === 'done') {
      return;
    }

    if (state.get(name) === 'visiting') {
      throw new Error(`dependency cycle: ${[...path, name].join(' → ')}`);
    }

    state.set(name, 'visiting');

    for (const dep of runtimeDeps(pkg).toSorted()) {
      const target = byName.get(dep);
      if (target !== undefined) {
        visit(target, [...path, name]);
      }
    }

    state.set(name, 'done');
    ordered.push(pkg);
  };

  for (const pkg of packages.toSorted((a, b) => a.manifest.name.localeCompare(b.manifest.name))) {
    visit(pkg, []);
  }

  return ordered;
}
