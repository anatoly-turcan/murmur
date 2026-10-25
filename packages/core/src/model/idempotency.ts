const IDEMPOTENT_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export const REQUEST_SCOPE_PATHS: readonly string[] = ['ip', 'peer'];

export const IDEMPOTENCY_DEFAULTS = {
  header: 'idempotency-key',
  ttlMs: 86_400_000,
  errors: {
    inProgress: { status: 409, code: 'conflict' },
    reused: { status: 422, code: 'invalid_input' },
  },
} as const;

export function idempotentMethodProblem(route: string, method: string, raw: boolean): string | undefined {
  if (!raw && IDEMPOTENT_METHODS.has(method)) {
    return undefined;
  }

  return `route ${route}: \`idempotent\` applies to POST/PUT/PATCH/DELETE on non-raw routes; drop it or change the method`;
}

function resolves(path: string, available: readonly string[], open: readonly string[]): boolean {
  return available.includes(path) || open.some((prefix) => path.startsWith(`${prefix}.`));
}

export function idempotentScopeProblem(
  route: string,
  scope: readonly string[],
  authPaths: readonly string[],
  openPaths: readonly string[] = [],
): string | undefined {
  const available = [...authPaths, ...REQUEST_SCOPE_PATHS];
  const stray = scope.find((path) => !resolves(path, available, openPaths));

  if (stray === undefined && scope.length > 0) {
    return undefined;
  }

  const named =
    stray === undefined ? 'is empty' : `\`${stray}\` does not resolve against this route's auth type`;

  return `route ${route}: scope ${named}; available: ${available.join(', ')}`;
}
