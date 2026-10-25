export function processNoPieceProblem(
  name: string,
  globs: readonly string[],
  ids: readonly string[],
): string {
  const listed = globs.map((glob) => `'${glob}'`).join(', ');
  const example = ids.toSorted()[0] ?? 'api';

  return `processes.${name}.pieces [${listed}] matches no piece; globs are piece ids (pieces/<id>/piece.ts → '<id>'), e.g. pieces: ['${example}', '${example}/**']`;
}
