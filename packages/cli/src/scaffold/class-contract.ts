import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ContractKind } from '../analysis/types.ts';
import { usageError } from '../errors.ts';
import { CONFIG_TYPES, parseKeyTypes, type KeyType } from './names.ts';
import { render } from './template.ts';

export interface ClassContractPlan {
  readonly root: string;
  readonly className: string;
  readonly domain: string;
  readonly kind: ContractKind;
  readonly input: readonly KeyType[];
  readonly output: string | null;
  readonly name: string | null;
}

export interface ClassContractScaffold {
  readonly file: string;
  readonly appended: boolean;
  readonly exists: boolean;
  readonly content: string;
}

const FACTORIES: Readonly<Record<ContractKind, string>> = {
  query: 'Query',
  command: 'Command',
  event: 'Event',
  guard: 'Guard',
};

const MURMUR_IMPORT = /import \{([^}]*)\} from 'murmur';?/;

function shape(fields: readonly KeyType[]): string {
  const entries = fields.map((k) => `${k.key}: ${CONFIG_TYPES[k.type]}`).join(', ');

  return entries === '' ? '{}' : `{ ${entries} }`;
}

function modelOutput(raw: string, source: string): string {
  const nullable = raw.endsWith('?');
  const list = raw.endsWith('[]');
  const model = raw.replace(/(\?|\[\])$/, '');

  if (!new RegExp(`class ${model} extends Model\\(`).test(source)) {
    throw usageError(
      `--output ${raw}: no Model class ${model} in this contracts file`,
      `declare it first: export class ${model} extends Model({ … }) {}`,
    );
  }

  if (nullable) {
    return `${model}.nullable()`;
  }

  return list ? `${model}.array()` : model;
}

function inlineOutput(raw: string): KeyType[] {
  const items = raw.split(',');
  if (items.some((item) => !item.includes(':'))) {
    throw usageError(
      `--output ${raw}: give a Model (Model, Model?, Model[]) or an inline shape as key:type,…`,
    );
  }

  return parseKeyTypes(items, 'output');
}

function outputText(raw: string | null, source: string): string {
  if (raw === null || raw === '') {
    return '{}';
  }

  if (/^[A-Z]\w*(\?|\[\])?$/.test(raw)) {
    return modelOutput(raw, source);
  }

  return shape(inlineOutput(raw));
}

function guardModel(plan: ClassContractPlan, source: string): string {
  const raw = plan.output ?? '';
  if (/^[A-Z]\w*$/.test(raw)) {
    return modelOutput(raw, source);
  }

  if (/^[A-Z]\w*(\?|\[\])$/.test(raw)) {
    throw usageError(`--output ${raw}: a guard answers one Model (--output Principal) or key:type,…`);
  }

  return `${plan.className}Output`;
}

function guardOutputBlock(plan: ClassContractPlan, source: string): string | null {
  const raw = plan.output ?? '';
  if (plan.kind !== 'guard' || /^[A-Z]\w*(\?|\[\])?$/.test(raw)) {
    return null;
  }

  const fields = raw === '' ? '{}' : shape(inlineOutput(raw));
  const name = guardModel(plan, source);

  return new RegExp(`class ${name}\\b`).test(source)
    ? null
    : `export class ${name} extends Model(${fields}) {}`;
}

function argsOf(plan: ClassContractPlan, source: string): string[] {
  const options = plan.name === null ? [] : [`{ name: '${plan.name}' }`];
  if (plan.kind === 'event') {
    return [shape(plan.input), ...options];
  }

  if (plan.kind === 'guard') {
    return [guardModel(plan, source), ...options];
  }

  return [shape(plan.input), outputText(plan.output, source), ...options];
}

function withMurmurName(source: string, name: string): string {
  const match = MURMUR_IMPORT.exec(source);
  if (match === null) {
    return `import { ${name} } from 'murmur';\n${source}`;
  }

  const names = (match[1] ?? '')
    .split(',')
    .map((n) => n.trim())
    .filter((n) => n !== '');

  if (names.includes(name)) {
    return source;
  }

  const sorted = [...names, name].toSorted((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

  return source.replace(MURMUR_IMPORT, `import { ${sorted.join(', ')} } from 'murmur';`);
}

function withZod(source: string, block: string): string {
  if (!block.includes('z.') || source.includes("from 'zod'")) {
    return source;
  }

  const murmur = MURMUR_IMPORT.exec(source);
  if (murmur === null) {
    return `import { z } from 'zod';\n${source}`;
  }

  const end = murmur.index + murmur[0].length;

  return `${source.slice(0, end)}\nimport { z } from 'zod';${source.slice(end)}`;
}

export function planClassContract(plan: ClassContractPlan): ClassContractScaffold {
  const file = join(plan.root, 'contracts', `${plan.domain.replace(/\.ts$/, '')}.ts`);
  const appended = existsSync(file);
  const current = appended ? readFileSync(file, 'utf8') : '';
  const exists = new RegExp(`export class ${plan.className}\\b`).test(current);
  const contract = render('class-contract.ts.tmpl', {
    className: plan.className,
    kind: FACTORIES[plan.kind],
    args: argsOf(plan, current).join(', '),
  });
  const model = guardOutputBlock(plan, current);
  const block = model === null ? contract : `${model}\n\n${contract}`;
  const named = withMurmurName(current, FACTORIES[plan.kind]);
  const imported = withZod(model === null ? named : withMurmurName(named, 'Model'), block);

  return { file, appended, exists, content: `${imported.trimEnd()}\n\n${block}` };
}
