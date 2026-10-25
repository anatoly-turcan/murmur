export interface ChaosOptions {
  duplicateEvery?: number;
  dropEvery?: number;
  seed?: number;
}

export type Fate = 'deliver' | 'duplicate' | 'drop';

function hits(every: number | undefined, count: number): boolean {
  return every !== undefined && every > 0 && count % every === 0;
}

export function chaosFates(chaos: ChaosOptions = {}): () => Fate {
  let count = chaos.seed ?? 0;

  return () => {
    count++;

    if (hits(chaos.dropEvery, count)) {
      return 'drop';
    }

    if (hits(chaos.duplicateEvery, count)) {
      return 'duplicate';
    }

    return 'deliver';
  };
}
