import {
  guardOrderProblem,
  metaKeyProblem,
  MurmurError,
  type GuardClass,
  type GuardRef,
  type GuardShape,
} from 'murmur';

function ref(guard: GuardClass): GuardRef {
  return { id: guard.name, label: guard.name };
}

function shapeOf(guard: GuardClass): GuardShape {
  return {
    ...ref(guard),
    after: guard.after.map(ref),
    optional: guard.optional.map(ref),
    metaKeys: Object.keys(guard.meta.shape),
  };
}

function admissionError(message: string | undefined, code: string): void {
  if (message !== undefined) {
    throw new MurmurError(message, { code, retryable: false });
  }
}

function invalidMeta(
  guard: GuardClass,
  meta: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const parsed = guard.meta.safeParse(meta);
  if (parsed.success) {
    return undefined;
  }

  const issues = parsed.error.issues.map((issue) => `${issue.path.join('.') || 'meta'}: ${issue.message}`);

  return `route ${key}: meta does not fit ${guard.name} (${issues.join('; ')}); give the route a meta value of the shape ${guard.name} declares`;
}

export function assertAdmission(
  guards: readonly GuardClass[],
  skipped: readonly GuardClass[],
  meta: Readonly<Record<string, unknown>>,
  key: string,
): void {
  const shapes = guards.map(shapeOf);
  admissionError(
    guardOrderProblem(
      key,
      shapes,
      skipped.map((guard) => guard.name),
    ),
    'guard-order',
  );
  admissionError(metaKeyProblem(key, shapes, Object.keys(meta)), 'guard-meta-unknown');
  admissionError(
    guards.map((guard) => invalidMeta(guard, meta, key)).find((problem) => problem !== undefined),
    'guard-meta-invalid',
  );
}
