import { envPrefixOf } from '../loader/piece-id.ts';

export interface EnvCollision {
  readonly envVar: string;
  readonly subjects: string[];
}

export interface EnvMap {
  readonly subjects: ReadonlyMap<string, string>;
  readonly collisions: readonly EnvCollision[];
}

export interface KeyedPiece {
  readonly id: string;
  readonly keys: readonly string[];
}

export interface KeyedCapability {
  readonly name: string;
  readonly keys: readonly string[];
}

export function envKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replaceAll('-', '_')
    .toUpperCase();
}

export function pieceEnvName(id: string, key: string): string {
  return `MURMUR__${envPrefixOf(id)}__${envKey(key)}`;
}

export function sharedEnvName(key: string): string {
  return `MURMUR__${envKey(key)}`;
}

export function capabilityEnvName(name: string, key: string): string {
  return `MURMUR__CAP_${envPrefixOf(name)}__${envKey(key)}`;
}

function entriesOf(
  pieces: readonly KeyedPiece[],
  capabilities: readonly KeyedCapability[],
): [string, string][] {
  return [
    ...pieces.flatMap((p) =>
      p.keys.map((key): [string, string] => [pieceEnvName(p.id, key), `${p.id}.${key}`]),
    ),
    ...pieces.flatMap((p) => p.keys.map((key): [string, string] => [sharedEnvName(key), `shared.${key}`])),
    ...capabilities.flatMap((c) =>
      c.keys.map((key): [string, string] => [
        capabilityEnvName(c.name, key),
        `capabilities.${c.name}.${key}`,
      ]),
    ),
  ];
}

export function buildEnvMap(pieces: readonly KeyedPiece[], capabilities: readonly KeyedCapability[]): EnvMap {
  const subjects = new Map<string, string>();
  const collisions = new Map<string, EnvCollision>();

  for (const [envVar, subject] of entriesOf(pieces, capabilities)) {
    const owner = subjects.get(envVar);
    if (owner === undefined) {
      subjects.set(envVar, subject);
    } else if (owner !== subject) {
      const collision = collisions.get(envVar) ?? { envVar, subjects: [owner] };
      if (!collision.subjects.includes(subject)) {
        collision.subjects.push(subject);
      }

      collisions.set(envVar, collision);
    }
  }

  return { subjects, collisions: [...collisions.values()] };
}
