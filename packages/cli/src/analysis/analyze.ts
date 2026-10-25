import { readAppFiles, type AppFiles } from './app-files.ts';
import { deriveCatalog } from './catalog.ts';
import { describe, type DescribeOptions } from './describe.ts';
import { discover } from './discover.ts';
import { finishStatics, startStatics, type StaticAnalysis } from './statics.ts';
import type { Catalog, Repo, RepoDescription } from './types.ts';

export interface Analysis {
  readonly repo: Repo;
  readonly description: RepoDescription;
  readonly files: AppFiles;
  readonly catalog: Catalog;
  readonly statics: StaticAnalysis;
}

export async function analyze(
  root: string,
  env: Readonly<Record<string, string | undefined>>,
  options: DescribeOptions = {},
): Promise<Analysis> {
  const repo = discover(root);
  const start = startStatics(repo);
  const described = await describe(repo, { ...options, skipPieces: start.classes.ids });
  const { description, statics } = finishStatics(repo, start, described);
  const files = readAppFiles(root);
  const catalog = deriveCatalog({
    repo,
    description,
    yaml: files.yaml,
    env,
    statics,
  });

  return { repo, description, files, catalog, statics };
}
