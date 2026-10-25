import {
  sendersOf,
  type CapabilityView,
  type CatalogWarningCode,
  type ContractView,
} from '@murmur/dev-protocol';

function nodeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_]/g, '_');
}

export function toMermaid(contracts: ContractView[], capabilities: CapabilityView[]): string {
  const lines = ['graph LR'];
  for (const cap of capabilities.filter((c) => c.kind === 'ingress')) {
    for (const piece of cap.usedBy) {
      lines.push(`  ${nodeId(`cap_${cap.name}`)}{{${cap.name}}} --> ${nodeId(piece)}["${piece}"]`);
    }
  }

  for (const c of contracts) {
    const arrow = c.visibility === 'internal' ? '-.->' : '-->';
    for (const from of sendersOf(c)) {
      for (const to of c.handlers) {
        lines.push(`  ${nodeId(from)}["${from}"] ${arrow}|${c.name}| ${nodeId(to)}["${to}"]`);
      }
    }
  }

  return lines.join('\n');
}

export const WHY: Record<CatalogWarningCode, string> = {
  'subscribed-never-emitted':
    'a handler waits for an event nobody publishes — dead code or a missing emitter',
  'emitted-never-subscribed': 'events go nowhere — either a missing consumer or a contract to delete',
  'requested-never-handled': 'every request will fail with NoRouteError at runtime',
  'missing-context-md': 'agents regenerate pieces from context.md; without it the piece cannot be rebuilt',
  'missing-summary': 'catalog rows, ctx and the tree show no one-line purpose',
  'missing-tests': 'the piece cannot be regenerated safely without tests pinning its behaviour',
  'orphan-contract': 'a declared contract nothing emits or handles — wire it to a consumer or delete it',
  'binding-conflict': 'two pieces claim one route — the app refuses to boot until one of them moves',
  'route-shadowed':
    'a route can never be reached because another piece matches it first — the app refuses to boot',
  'route-family-split':
    'one path family served by several pieces — the next route there has no obvious owner',
  'guard-never-handled': 'every request through this guard will fail until a piece handles it',
  'guard-output-overlap':
    'two guards return the same field — req.auth would keep one silently; the app refuses to boot',
  'guard-order': 'a guard would run before a guard whose output it reads — the app refuses to boot',
  'guard-meta-unknown': 'a route meta key no kept guard reads — a typo the app refuses to boot with',
};
