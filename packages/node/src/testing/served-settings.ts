import type { IngressTarget, PieceClass } from 'murmur';

import type { HttpSettings } from '../capabilities/http/binding.ts';
import { settingsOf, UNTOKENED_SETTINGS } from '../capabilities/http/settings.ts';

export function servedSettings(
  targets: readonly IngressTarget[],
  pieces: readonly PieceClass[],
): HttpSettings {
  const served = targets.map((target) => target.serve.binding.capability);
  const needed = pieces.flatMap((piece) => Object.values(piece.declaration.needs ?? {}));

  return settingsOf([...served, ...needed]) ?? UNTOKENED_SETTINGS;
}
