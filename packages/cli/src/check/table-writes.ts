import { join, relative } from 'node:path';

import type { Analysis } from '../analysis/analyze.ts';
import { callArguments, child, identifierName, parse, positionOf, walk, type Node } from '../analysis/ast.ts';
import { pieceNodes } from '../analysis/discover.ts';
import { readSource } from '../analysis/source-checks.ts';
import { sqlStatements, withoutComments } from '../analysis/storage-sql.ts';
import type { FolderNode } from '../analysis/types.ts';
import { finding, type Finding } from './finding.ts';

interface Owner {
  readonly piece: string;
  readonly schema: string;
}

interface Write {
  readonly table: string;
  readonly offset: number;
}

const NAME = String.raw`(?:\w+\.)?["\`[]?(\w+)`;
const CREATE = new RegExp(String.raw`^CREATE\s+(?:TEMP\w*\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${NAME}`, 'i');
const WRITE = new RegExp(
  String.raw`\b(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)\s+${NAME}`,
  'gi',
);

function isSchema(path: string): boolean {
  return path === 'schema.sql' || path.endsWith('/schema.sql');
}

function createdTables(file: string): string[] {
  return sqlStatements(readSource(file) ?? '').flatMap((statement) => {
    const name = CREATE.exec(withoutComments(statement).trim())?.[1];

    return name === undefined ? [] : [name.toLowerCase()];
  });
}

function tableOwners(analysis: Analysis): Map<string, Owner[]> {
  const owners = new Map<string, Owner[]>();
  for (const node of pieceNodes(analysis.repo)) {
    for (const path of node.files.filter(isSchema)) {
      const file = join(node.dir, path);
      const schema = relative(analysis.repo.root, file);

      for (const table of createdTables(file)) {
        owners.set(table, [...(owners.get(table) ?? []), { piece: node.id, schema }]);
      }
    }
  }

  return owners;
}

function textOf(node: Node): string | null {
  if (node.type === 'Literal' && typeof node['value'] === 'string') {
    return node['value'];
  }

  const value = node.type === 'TemplateElement' ? (node['value'] as { cooked?: unknown }) : undefined;

  return typeof value?.cooked === 'string' ? value.cooked : null;
}

function sqlWrites(node: Node): Write[] {
  const text = textOf(node);

  return text === null
    ? []
    : [...text.matchAll(WRITE)].map((m) => ({ table: (m[1] as string).toLowerCase(), offset: node.start }));
}

function insertCall(node: Node): Write[] {
  const callee = node.type === 'CallExpression' ? child(node, 'callee') : undefined;
  const [table] = callee?.type === 'MemberExpression' ? callArguments(node) : [];

  if (identifierName(callee === undefined ? undefined : child(callee, 'property')) !== 'insert') {
    return [];
  }

  return table?.type === 'Literal' && typeof table['value'] === 'string'
    ? [{ table: table['value'].toLowerCase(), offset: table.start }]
    : [];
}

function writesIn(file: string, source: string): Write[] {
  const writes: Write[] = [];
  walk(parse(file, source)?.program, (node) => {
    writes.push(...sqlWrites(node), ...insertCall(node));
  });

  return writes;
}

function isSource(path: string): boolean {
  return path.endsWith('.ts') && !path.endsWith('.test.ts') && !path.startsWith('fixtures/');
}

function fileFindings(
  analysis: Analysis,
  owners: Map<string, Owner[]>,
  node: FolderNode,
  path: string,
): Finding[] {
  const file = join(node.dir, path);
  const source = readSource(file) ?? '';

  return writesIn(file, source).flatMap(({ table, offset }) => {
    const creators = owners.get(table) ?? [];
    if (creators.length === 0 || creators.some((owner) => owner.piece === node.id)) {
      return [];
    }

    const schemas = creators.map((owner) => owner.schema).join(' and ');
    const message = `pieces/${node.id} writes \`${table}\`, created by ${schemas}; move the write to its owner or make it a job that owner handles`;

    return [
      finding(
        'table-foreign-write',
        'warn',
        relative(analysis.repo.root, file),
        message,
        positionOf(source, offset),
      ),
    ];
  });
}

export function tableWriteFindings(analysis: Analysis): Finding[] {
  const owners = tableOwners(analysis);

  return pieceNodes(analysis.repo).flatMap((node) =>
    node.files.filter(isSource).flatMap((path) => fileFindings(analysis, owners, node, path)),
  );
}
