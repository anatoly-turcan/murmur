import type { WorkspacePackage } from './manifest.ts';

export interface ReleaseNotesInput {
  readonly sha: string;
  readonly date: string;
  readonly packages: readonly WorkspacePackage[];
  readonly tarballs: readonly string[];
}

function versionOf(packages: readonly WorkspacePackage[]): string {
  const versions = [...new Set(packages.map((pkg) => pkg.manifest.version))];

  return versions.length === 1 ? (versions[0] ?? '') : versions.join(' / ');
}

function tarballName(pkg: WorkspacePackage): string {
  return `${pkg.manifest.name.replace('@', '').replace('/', '-')}-${pkg.manifest.version}.tgz`;
}

function tarballSection(tarballs: readonly string[], packages: readonly WorkspacePackage[]): string[] {
  if (tarballs.length === 0) {
    return [];
  }

  const ordered = packages.map(tarballName).filter((file) => tarballs.includes(file));

  return [
    '## Tarballs',
    '',
    '`packages/` holds every package as packed by pnpm (workspace links already pinned). To host them on your own',
    'npm-compatible registry, publish them in this order:',
    '',
    '```sh',
    ...ordered.map((file) => `pnpm publish packages/${file} --registry "$NPM_REGISTRY"`),
    '```',
    '',
  ];
}

export function releaseNotes(input: ReleaseNotesInput): string {
  const version = versionOf(input.packages);
  const rows = input.packages.map((pkg) => `| \`${pkg.manifest.name}\` | ${pkg.manifest.version} |`);

  return [
    `# murmur ${version}`,
    '',
    `- git: \`${input.sha}\``,
    `- built: ${input.date}`,
    '- distribution: private npm-compatible registry (verdaccio or similar); nothing is on the public npm registry',
    '',
    '| package | version |',
    '| --- | --- |',
    ...rows,
    '',
    '## Install',
    '',
    'Point pnpm at the registry that hosts these packages (it must also proxy the public registry), then scaffold:',
    '',
    '```sh',
    'pnpm config set registry "$NPM_REGISTRY"',
    `pnpm dlx @murmur/cli@${version} new app my-app`,
    'cd my-app && pnpm install',
    '```',
    '',
    'See README.md for everything else. `plugins/murmur` is the Claude Code plugin (`plugins` is its marketplace), `examples/` the example app.',
    '',
    ...tarballSection(input.tarballs, input.packages),
  ].join('\n');
}
