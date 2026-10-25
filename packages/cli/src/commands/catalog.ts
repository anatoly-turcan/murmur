import { analyze } from '../analysis/analyze.ts';
import { filterCatalog, withStrictWarnings } from '../analysis/catalog.ts';
import { writeLaneSnapshot } from '../analysis/lane-snapshot.ts';
import type { Catalog } from '../analysis/types.ts';
import { choiceOption, flag, stringOption, type Command, type CommandContext } from '../command.ts';
import { EXIT } from '../errors.ts';
import type { Output } from '../output.ts';
import { renderCatalogMarkdown, renderCatalogMermaid, renderCatalogTable } from '../render/catalog.ts';
import { requireRoot } from '../root.ts';

const FORMATS = ['table', 'json', 'md', 'mermaid'] as const;
type Format = (typeof FORMATS)[number];

const RENDERERS: Record<Exclude<Format, 'json'>, (catalog: Catalog) => string> = {
  table: renderCatalogTable,
  md: renderCatalogMarkdown,
  mermaid: renderCatalogMermaid,
};

function write(out: Output, format: Format, catalog: Catalog): void {
  if (format === 'json' || out.json) {
    out.emit({ kind: 'catalog', ...catalog });
  } else {
    out.print(RENDERERS[format](catalog));
  }
}

function reportErrors(out: Output, catalog: Catalog): void {
  for (const error of catalog.errors) {
    out.warn(`error ${error.code}: ${error.message} (${error.file})`);
  }
}

async function run(ctx: CommandContext): Promise<number> {
  const format = choiceOption(ctx, 'format', FORMATS, 'table');
  const group = stringOption(ctx, 'group');
  const contract = stringOption(ctx, 'contract');
  const strict = flag(ctx, 'strict');
  const analysis = await analyze(requireRoot(ctx.cwd), ctx.env);
  writeLaneSnapshot(analysis, 'catalog');
  const derived = analysis.catalog;
  const full = strict ? withStrictWarnings(derived) : derived;
  const catalog = filterCatalog(full, {
    ...(group === undefined ? {} : { group }),
    ...(contract === undefined ? {} : { contract }),
  });
  write(ctx.out, format, catalog);

  if (catalog.errors.length > 0) {
    reportErrors(ctx.out, catalog);

    return EXIT.boot;
  }

  return strict && catalog.warnings.length > 0 ? EXIT.findings : EXIT.ok;
}

export const catalogCommand: Command = {
  usage: 'catalog [--format table|json|md|mermaid] [--strict] [--group <prefix>] [--contract <name>]',
  options: {
    format: { type: 'string' },
    strict: { type: 'boolean' },
    group: { type: 'string' },
    contract: { type: 'string' },
  },
  run,
};
