import type { Ids } from 'murmur';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

function short(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));

  return Array.from(bytes, (byte) => ALPHABET[byte % ALPHABET.length]).join('');
}

export const systemIds: Ids = Object.freeze({ uuid: () => crypto.randomUUID(), short });
