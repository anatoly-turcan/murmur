export interface GuardRef {
  readonly id: string;
  readonly label: string;
}

export interface GuardShape extends GuardRef {
  readonly after: readonly GuardRef[];
  readonly optional: readonly GuardRef[];
  readonly metaKeys: readonly string[];
}

function indexOf(guards: readonly GuardShape[], ref: GuardRef): number {
  return guards.findIndex((guard) => guard.id === ref.id);
}

function afterProblem(
  route: string,
  guards: readonly GuardShape[],
  skipped: readonly string[],
  at: number,
): string | undefined {
  const guard = guards[at] as GuardShape;
  const y = guard.label;

  for (const needed of guard.after) {
    const index = indexOf(guards, needed);
    const z = needed.label;

    if (index === -1 && skipped.includes(needed.id)) {
      return `route ${route} skips ${z} but keeps ${y}, whose \`after\` names ${z}; skip ${y} too, or declare ${z} in ${y}'s \`optional\``;
    }

    if (index === -1) {
      return `route ${route}: ${y} lists ${z} in \`after\`, but the route does not run ${z}; add ${z} to the token's guards before ${y}, or declare ${z} in ${y}'s \`optional\``;
    }

    if (index > at) {
      return `route ${route}: ${y} runs before ${z}, which ${y} lists in \`after\`; reorder the token's guards, or make ${z} \`optional\` on ${y}`;
    }
  }

  const late = guard.optional.find((maybe) => indexOf(guards, maybe) > at);
  if (late !== undefined) {
    return `route ${route}: ${y} runs before ${late.label}, which ${y} lists in \`optional\`; reorder the token's guards so ${late.label} runs first`;
  }

  return undefined;
}

export function guardOrderProblem(
  route: string,
  guards: readonly GuardShape[],
  skipped: readonly string[],
): string | undefined {
  return guards.map((_guard, at) => afterProblem(route, guards, skipped, at)).find((p) => p !== undefined);
}

export function acceptedMetaKeys(guards: readonly GuardShape[]): string[] {
  return [...new Set(guards.flatMap((guard) => guard.metaKeys))];
}

export function metaKeyProblem(
  route: string,
  guards: readonly GuardShape[],
  keys: readonly string[],
): string | undefined {
  const accepted = acceptedMetaKeys(guards);
  const stray = keys.find((key) => !accepted.includes(key));

  if (stray === undefined) {
    return undefined;
  }

  const allowed = accepted.length === 0 ? 'no meta keys' : accepted.join(', ');

  return `route ${route}: meta key \`${stray}\` is read by no kept guard; the kept guards accept ${allowed}`;
}
