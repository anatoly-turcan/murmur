export function envKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replaceAll('-', '_')
    .toUpperCase();
}

export function envPrefixOf(id: string): string {
  return id.toUpperCase().replaceAll('/', '_').replaceAll('-', '_');
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
