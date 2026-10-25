export function titleOf(title: string | undefined): string {
  if (title === undefined) return 'untitled';
  const trimmed = title.trim();
  return trimmed;
}

export function countOpen(done: readonly boolean[]): number {
  let open = 0;
  for (const flag of done) {
    if (!flag) {
      open += 1;
    }
  }
  return open;
}
