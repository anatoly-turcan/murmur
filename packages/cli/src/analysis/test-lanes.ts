import { importedContracts } from './contract-imports.ts';
import { unique, type Lanes } from './lanes.ts';
import type { ContractInfo } from './types.ts';

export interface TestLaneInput {
  readonly contracts: readonly ContractInfo[];
  readonly capabilities: readonly string[];
  readonly root: string;
  readonly dir: string;
  readonly sources: readonly string[];
}

const DEFAULTS = new Set(['log', 'clock', 'ids']);
const HARNESS_CALL = /\.(deliver|deliverJson|emitted|respond|requested)\(\s*([A-Za-z_$][\w$]*)/g;
const FAKE_CALL = /\bfake([A-Z][\w$]*)\(/g;
const CAPABILITIES_KEY = /\bcapabilities\s*:\s*\{/g;
const NEEDS_KEY = /\bneeds\s*:\s*\{/g;
const NEEDS_READ = /\.needs\.([A-Za-z_$][\w$]*)/g;
const FETCH_CALL = /\.fetch\(\s*(?:new\s+Request\(\s*)?(['"`])([^'"`]+)\1\s*(?:,\s*\{([^}]*)\})?/g;
const METHOD_OPTION = /\bmethod\s*:\s*['"`]([A-Za-z]+)['"`]/;

interface Usage {
  readonly method: string;
  readonly contract: ContractInfo;
}

function usages(input: TestLaneInput, source: string): Usage[] {
  const imported = importedContracts(input.contracts, input.root, input.dir, source);

  return [...source.matchAll(HARNESS_CALL)].flatMap((m) => {
    const contract = imported.get(m[2] as string);

    return contract === undefined ? [] : [{ method: m[1] as string, contract }];
  });
}

function topLevelKeys(source: string, open: number): string[] {
  const keys: string[] = [];
  let depth = 0;
  let item = '';

  for (const char of source.slice(open)) {
    if ('{(['.includes(char)) {
      depth++;
    }

    if ('})]'.includes(char)) {
      depth--;
    }

    if (depth === 0) {
      break;
    }

    if (depth === 1 && char === ',') {
      keys.push(item);
      item = '';
    } else if (depth === 1 && char !== '{') {
      item += char;
    }
  }

  keys.push(item);

  return keys.flatMap((k) => /^\s*([A-Za-z_$][\w$]*)\s*(?::|$)/.exec(k)?.slice(1, 2) ?? []);
}

function capabilityKeys(source: string): string[] {
  return [...source.matchAll(CAPABILITIES_KEY)].flatMap((m) =>
    topLevelKeys(source, (m.index ?? 0) + m[0].length - 1),
  );
}

function fakeNames(source: string): string[] {
  return [...source.matchAll(FAKE_CALL)].map((m) => {
    const name = m[1] as string;

    return name.charAt(0).toLowerCase() + name.slice(1);
  });
}

function keysAfter(source: string, pattern: RegExp): string[] {
  return [...source.matchAll(pattern)].flatMap((m) => topLevelKeys(source, (m.index ?? 0) + m[0].length - 1));
}

function fakeOfField(source: string, field: string): string | null {
  const assigned = new RegExp(`\\b${field}\\s*[:=]\\s*(?:await\\s+)?fake([A-Z][\\w$]*)\\(`).exec(source)?.[1];
  if (assigned !== undefined) {
    return assigned.charAt(0).toLowerCase() + assigned.slice(1);
  }

  const fakes = unique(fakeNames(source));

  return fakes.length === 1 ? (fakes[0] as string) : null;
}

function fieldNeeds(source: string): string[] {
  const read = [...source.matchAll(NEEDS_READ)].map((m) => m[1] as string);

  return unique([...keysAfter(source, NEEDS_KEY), ...read]).map((field) => {
    const capability = fakeOfField(source, field);

    return capability === null ? field : `${field}=${capability}`;
  });
}

function needsOf(input: TestLaneInput): string[] {
  const fields = input.sources.flatMap(fieldNeeds);
  if (fields.length > 0) {
    return unique(fields);
  }

  const named = input.sources.flatMap((source) => [...capabilityKeys(source), ...fakeNames(source)]);
  const known = new Set(input.capabilities);

  return unique(named).filter((name) => !DEFAULTS.has(name) && (known.size === 0 || known.has(name)));
}

function pathOf(target: string): string {
  const url = URL.parse(target, 'http://app');

  return url === null ? target : url.pathname;
}

function servesOf(sources: readonly string[]): string[] {
  const keys = sources.flatMap((source) =>
    [...source.matchAll(FETCH_CALL)].map((m) => {
      const method = METHOD_OPTION.exec(m[3] ?? '')?.[1]?.toUpperCase() ?? 'GET';

      return `${method} ${pathOf(m[2] as string)}`;
    }),
  );

  return unique(keys);
}

function laneOf(usage: Usage): 'listens' | 'emits' | 'requests' {
  if (usage.method === 'deliver' || usage.method === 'deliverJson') {
    return 'listens';
  }

  if (usage.method === 'respond' || usage.method === 'requested' || usage.contract.hasReply) {
    return 'requests';
  }

  return 'emits';
}

export function testLanes(input: TestLaneInput): Lanes {
  const all = input.sources.flatMap((source) => usages(input, source));
  const names = (lane: ReturnType<typeof laneOf>) =>
    unique(all.filter((u) => laneOf(u) === lane).map((u) => u.contract.name));

  return {
    needs: needsOf(input),
    listens: names('listens'),
    emits: names('emits'),
    requests: names('requests'),
    serves: servesOf(input.sources),
  };
}
