import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { Analysis } from '../analysis/analyze.ts';
import { callArguments, child, identifierName, parse, positionOf, walk, type Node } from '../analysis/ast.ts';
import { pieceNodes } from '../analysis/discover.ts';
import { readSource } from '../analysis/source-checks.ts';
import type { FolderNode } from '../analysis/types.ts';
import { finding, type Finding } from './finding.ts';

const FILE_READERS = new Set([
  'readFileSync',
  'readFile',
  'createReadStream',
  'openSync',
  'readdirSync',
  'readdir',
  'opendir',
  'statSync',
  'stat',
]);

const PATH_BUILDERS = new Set(['join', 'resolve']);

function literal(node: Node | undefined): string | null {
  return node?.type === 'Literal' && typeof node['value'] === 'string' ? node['value'] : null;
}

function isImportMeta(node: Node | undefined, property: string): boolean {
  const object = node?.type === 'MemberExpression' ? child(node, 'object') : undefined;

  return object?.type === 'MetaProperty' && identifierName(child(node as Node, 'property')) === property;
}

function urlTarget(dir: string, node: Node): string | null {
  const [path, base] = callArguments(node);
  const text = literal(path);

  if (identifierName(child(node, 'callee')) !== 'URL' || text === null || !isImportMeta(base, 'url')) {
    return null;
  }

  return resolve(dir, text);
}

function builtTarget(dir: string, node: Node): string | null {
  const [base, ...rest] = callArguments(node);
  const parts = rest.map(literal);

  if (!PATH_BUILDERS.has(identifierName(child(node, 'callee')) ?? '') || !isImportMeta(base, 'dirname')) {
    return null;
  }

  if (parts.some((part) => part === null)) {
    return null;
  }

  return join(dir, ...(parts as string[]));
}

function readerTarget(dir: string, node: Node): string | null {
  const text = literal(callArguments(node)[0]);
  if (!FILE_READERS.has(identifierName(child(node, 'callee')) ?? '') || text === null) {
    return null;
  }

  if (isAbsolute(text)) {
    return text;
  }

  return text.startsWith('..') ? resolve(dir, text) : null;
}

function targetOf(dir: string, node: Node): string | null {
  if (node.type === 'NewExpression') {
    return urlTarget(dir, node);
  }

  if (node.type !== 'CallExpression') {
    return null;
  }

  return builtTarget(dir, node) ?? readerTarget(dir, node);
}

function isInside(folder: string, path: string): boolean {
  return path === folder || path.startsWith(`${folder}${sep}`);
}

function fileFindings(analysis: Analysis, node: FolderNode, path: string): Finding[] {
  const file = join(node.dir, path);
  const source = readSource(file) ?? '';
  const parsed = parse(file, source);
  const found: Finding[] = [];

  walk(parsed?.program, (candidate) => {
    const target = targetOf(dirname(file), candidate);
    if (target === null || isInside(node.dir, target)) {
      return;
    }

    const where = relative(analysis.repo.root, target);
    const message = `${node.id} reads ${where}, outside its folder; a piece reads only its own files (move the file into pieces/${node.id}/ or ask its owner through a contract)`;
    found.push(
      finding(
        'folder-local-files',
        'warn',
        relative(analysis.repo.root, file),
        message,
        positionOf(source, candidate.start),
      ),
    );
  });

  return found;
}

export function folderFileFindings(analysis: Analysis): Finding[] {
  return pieceNodes(analysis.repo).flatMap((node) =>
    node.files.filter((path) => path.endsWith('.ts')).flatMap((path) => fileFindings(analysis, node, path)),
  );
}
