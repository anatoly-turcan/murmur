import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { validatePieceId } from 'murmur';

import type { Analysis } from '../analysis/analyze.ts';
import { pieceNodes } from '../analysis/discover.ts';
import type { FolderNode, PieceInfo } from '../analysis/types.ts';
import { finding, type Finding } from './finding.ts';
import { processFindings } from './processes.ts';
import { sizingFindings } from './sizing.ts';
import { staticFindings } from './static-findings.ts';

const GROUP_FILES = new Set(['context.md', 'contracts.ts', 'scenario.test.ts']);
const DEFAULT_CAPABILITIES = ['log', 'clock', 'ids'];

function rel(analysis: Analysis, file: string): string {
  return relative(analysis.repo.root, file);
}

function contextFindings(analysis: Analysis, node: FolderNode): Finding[] {
  const file = rel(analysis, join(node.dir, 'context.md'));
  if (node.contextFile === null) {
    return node.kind === 'piece'
      ? [finding('context-md-missing', 'error', file, `${node.id} has no context.md`)]
      : [];
  }

  if (node.frontmatterError !== null) {
    return [
      finding(
        'context-md-frontmatter',
        'error',
        file,
        `frontmatter does not parse: ${node.frontmatterError}`,
      ),
    ];
  }

  if (!node.hasFrontmatter && node.kind === 'piece') {
    return [
      finding('context-md-frontmatter', 'error', file, 'context.md needs a frontmatter block with summary'),
    ];
  }

  if (node.summary === null && node.id !== '') {
    return [finding('missing-summary', 'warn', file, `${node.id}/context.md has no frontmatter summary`)];
  }

  return [];
}

function groupFindings(analysis: Analysis, node: FolderNode): Finding[] {
  if (node.kind !== 'group' || node.id === '') {
    return [];
  }

  return node.files
    .filter((name) => !GROUP_FILES.has(name))
    .map((name) => {
      const file = rel(analysis, join(node.dir, name));
      const message =
        name === 'piece.test.ts'
          ? 'piece.test.ts needs a piece.ts beside it; a subtree test is scenario.test.ts'
          : 'group folders hold only context.md, contracts.ts and scenario.test.ts; code belongs in a piece folder';

      return finding('group-folder-files', 'error', file, message);
    });
}

function idFindings(analysis: Analysis, node: FolderNode): Finding[] {
  try {
    validatePieceId(node.id);

    return [];
  } catch (error) {
    return [finding('piece-id', 'error', rel(analysis, node.pieceFile as string), (error as Error).message)];
  }
}

function importFindings(analysis: Analysis, info: PieceInfo): Finding[] {
  if (info.error === null) {
    return [];
  }

  return [
    finding('piece-import', 'error', rel(analysis, info.file), `piece.ts does not import: ${info.error}`),
  ];
}

function handlerFindings(analysis: Analysis, info: PieceInfo): Finding[] {
  return info.handlers
    .filter((h) => !h.exported)
    .map((h) =>
      finding(
        'handler-contract-unexported',
        'error',
        rel(analysis, info.file),
        `${info.id} handles ${h.contract}, which is not exported from contracts/*.ts or an ancestor contracts.ts`,
      ),
    );
}

function needsFindings(analysis: Analysis, info: PieceInfo): Finding[] {
  if (!analysis.description.appLoaded) {
    return [];
  }

  const known = new Set([...DEFAULT_CAPABILITIES, ...analysis.description.capabilities.map((c) => c.name)]);

  return info.needs
    .filter((name) => !known.has(name))
    .map((name) =>
      finding(
        'needs-unknown',
        'error',
        rel(analysis, info.file),
        `${info.id} needs "${name}" but no capability "${name}" is defined`,
      ),
    );
}

function pieceFindings(analysis: Analysis, node: FolderNode): Finding[] {
  const info = analysis.description.pieces.find((p) => p.id === node.id);
  const fromInfo =
    info === undefined
      ? []
      : [
          ...importFindings(analysis, info),
          ...handlerFindings(analysis, info),
          ...needsFindings(analysis, info),
        ];

  return [...idFindings(analysis, node), ...fromInfo, ...sizingFindings(analysis, node, info)];
}

function contractFindings(analysis: Analysis): Finding[] {
  const { description } = analysis;

  return [
    ...description.importErrors.map((e) =>
      finding('contract-import', 'error', rel(analysis, e.file), `does not import: ${e.message}`),
    ),
    ...description.contracts
      .filter((c) => c.schemaError !== null)
      .map((c) =>
        finding(
          'contract-json-schema',
          'error',
          rel(analysis, c.file),
          `${c.name} is not JSON-faithful: ${c.schemaError}`,
        ),
      ),
    ...description.errors.map((e) => finding(e.code, 'error', rel(analysis, e.file), e.message)),
  ];
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function tsconfigFindings(analysis: Analysis): Finding[] {
  const config = readJson(join(analysis.repo.root, 'tsconfig.json'));
  if (Array.isArray(config?.['include'])) {
    return [];
  }

  return [
    finding(
      'tsconfig-include',
      'error',
      'tsconfig.json',
      'tsconfig.json must declare "include" (a base include is rebased into node_modules)',
    ),
  ];
}

function oxlintFindings(analysis: Analysis): Finding[] {
  const config = readJson(join(analysis.repo.root, '.oxlintrc.json'));
  const extendsList = config?.['extends'];

  if (!Array.isArray(extendsList)) {
    return [
      finding(
        'oxlintrc-extends',
        'error',
        '.oxlintrc.json',
        '.oxlintrc.json must extend ./node_modules/@murmur/lint/preset.json',
      ),
    ];
  }

  return extendsList
    .filter((path) => typeof path !== 'string' || !existsSync(join(analysis.repo.root, path)))
    .map((path) =>
      finding(
        'oxlintrc-extends',
        'error',
        '.oxlintrc.json',
        `extends ${String(path)} does not resolve to a file`,
      ),
    );
}

function appFindings(analysis: Analysis): Finding[] {
  const yaml = analysis.files.yamlError;
  const app = analysis.description.appError;

  return [
    ...(yaml === null
      ? []
      : [finding('yaml-parse', 'error', 'murmur.yaml', `murmur.yaml does not parse: ${yaml}`)]),
    ...(app === null
      ? []
      : [
          finding(
            'needs-unchecked',
            'warn',
            'murmur.config.ts',
            `murmur.config.ts does not import, needs not checked: ${app}`,
          ),
        ]),
    ...tsconfigFindings(analysis),
    ...oxlintFindings(analysis),
  ];
}

export function structureFindings(analysis: Analysis): Finding[] {
  const folders = [...analysis.repo.folders.values()];

  return [
    ...folders.flatMap((node) => [...contextFindings(analysis, node), ...groupFindings(analysis, node)]),
    ...pieceNodes(analysis.repo).flatMap((node) => pieceFindings(analysis, node)),
    ...contractFindings(analysis),
    ...staticFindings(analysis),
    ...processFindings(analysis),
    ...appFindings(analysis),
  ];
}
