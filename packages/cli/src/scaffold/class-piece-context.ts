import { join } from 'node:path';

import {
  classDir,
  eventsOf,
  methodOfHandle,
  requestsOf,
  serveKey,
  type ClassPiecePlan,
} from './class-piece-model.ts';
import { laneLine } from './names.ts';
import type { PlannedFile } from './piece.ts';
import { render, yamlScalar } from './template.ts';

function requestNames(plan: ClassPiecePlan): string[] {
  const served = plan.serves.flatMap((s) => (s.contract === null ? [] : [s.contract.name]));

  return [...new Set([...requestsOf(plan).map((c) => c.name), ...served])];
}

function lanes(plan: ClassPiecePlan): string {
  return [
    laneLine(
      'Handles',
      plan.handles.map((h) => h.contract.name),
    ),
    laneLine(
      'Emits',
      eventsOf(plan).map((c) => c.name),
    ),
    laneLine('Requests', requestNames(plan)),
    laneLine('Serves', plan.serves.map(serveKey)),
  ].join('\n');
}

function laneProse(plan: ClassPiecePlan): string {
  const lines = [
    ...plan.handles.map((h) => `- handles \`${h.contract.name}\` in \`${methodOfHandle(h.contract)}\``),
    ...eventsOf(plan).map((c) => `- emits \`${c.name}\``),
    ...requestNames(plan).map((name) => `- requests \`${name}\``),
    ...plan.serves.map(
      (s) => `- serves \`${serveKey(s)}\`${s.contract === null ? '' : ` → \`${s.contract.name}\``}`,
    ),
  ];

  return lines.length === 0 ? '- nothing yet' : lines.join('\n');
}

function needsText(plan: ClassPiecePlan): string {
  const caps = plan.needs.map((n) => n.cap);
  const storage = caps.includes('sqlite') ? ['Storage: `./schema.sql`'] : [];
  const prose = plan.needs.map((n) => `- \`${n.cap}\` as \`this.${n.field}\` — what for.`);

  return [
    [laneLine('Needs', caps), ...storage].join('\n'),
    ...(prose.length === 0 ? [] : [prose.join('\n')]),
  ].join('\n\n');
}

function invariant(plan: ClassPiecePlan): string {
  if (plan.idempotent) {
    return 'Idempotent: a redelivered envelope id changes nothing twice. How: command and event handlers claim the id in the `handled` table first; queries change nothing.';
  }

  return plan.handles.length === 0
    ? 'An edge translates HTTP to contracts and keeps no state.'
    : 'Idempotent: redelivery of the same envelope id must not duplicate side effects. How: …';
}

export function contextFile(plan: ClassPiecePlan): PlannedFile {
  return {
    path: join(classDir(plan), 'context.md'),
    content: render('piece/class-context.md.tmpl', {
      title: yamlScalar(plan.id.split('/').at(-1) ?? plan.id),
      summary: yamlScalar(plan.summary ?? 'TODO one line on what this piece does'),
      id: plan.id,
      lanes: lanes(plan),
      lines: laneProse(plan),
      needs: needsText(plan),
      invariant: invariant(plan),
    }),
  };
}
