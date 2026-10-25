export const CHANGE_REQUESTS = ['CR-1', 'CR-2', 'CR-3'] as const;
export type CrId = (typeof CHANGE_REQUESTS)[number];
export type CrMode = 'none' | CrId;

export function parseCrMode(raw: string | undefined): CrMode {
  const value = (raw ?? '').trim();
  if (value === '' || value.toLowerCase() === 'none') return 'none';
  const match = /^cr-?([1-3])$/i.exec(value);
  if (!match) throw new Error(`SUITE_CR must be none, CR-1, CR-2 or CR-3, got ${JSON.stringify(raw)}`);

  return `CR-${match[1]}` as CrId;
}

export function crLevel(mode: CrMode): number {
  return mode === 'none' ? 0 : Number(mode.slice(3));
}

export const crMode: CrMode = parseCrMode(process.env.SUITE_CR);
