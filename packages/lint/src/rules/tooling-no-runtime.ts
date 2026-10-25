import { sep } from 'node:path';

import { onImports, packageNameOf } from '../imports.ts';
import type { AstNode, Rule, RuleContext, Visitors } from '../types.ts';

export const runtimeExports: readonly string[] = [
  'createBus',
  'classPieceRuntime',
  'ClassPieceInit',
  'busContractOf',
  'BusContract',
  'PiecePort',
  'Bus',
  'BusOptions',
  'BusStacks',
  'LifecycleHook',
  'LogLine',
  'PieceHandlerEntry',
  'PieceRuntime',
  'Registration',
  'current',
  'isSettledLifecycleRun',
  'markLifecycleSettled',
  'ContextStorage',
  'createEnvelope',
  'parseEnvelope',
  'serializeEnvelope',
  'systemClock',
  'backoff',
  'EnvelopeInit',
  'CascadeDepthError',
  'DuplicateResponderError',
  'EnvelopeShapeError',
  'HandlerTimeoutError',
  'NoHandlerError',
  'NoRouteError',
  'PayloadTooLargeError',
  'RemoteError',
  'RequestTimeoutError',
  'ShutdownError',
  'TransportError',
  'TransportDelivery',
  'DeliveryHandler',
  'PublishOptions',
  'SubscribeOptions',
  'Subscription',
  'Transport',
  'TransportFeatures',
];

const message = (subject: string) =>
  `tooling imports the piece model only (plus @murmur/dev-protocol); ${subject} belongs to the app process`;

function allowList(options: readonly unknown[]): string[] {
  const first = options[0] as { allow?: unknown } | undefined;

  return Array.isArray(first?.allow) ? first.allow.filter((path) => typeof path === 'string') : [];
}

function isAllowed(filename: string, allow: readonly string[]): boolean {
  const path = filename.split(sep).join('/');

  return allow.some((entry) => path === entry || path.endsWith(`/${entry}`));
}

function isRuntimePackage(specifier: string): boolean {
  const name = packageNameOf(specifier);

  return name === '@murmur/node' || name.startsWith('@murmur/transport-');
}

function namedRuntimeImports(node: AstNode): AstNode[] {
  return (node.specifiers ?? []).filter((specifier) => {
    const name = specifier.type === 'ExportSpecifier' ? specifier.local?.name : specifier.imported?.name;

    return specifier.type !== 'ImportDefaultSpecifier' && runtimeExports.includes(name ?? '');
  });
}

function create(context: RuleContext): Visitors {
  if (isAllowed(context.filename, allowList(context.options))) {
    return {};
  }

  return onImports((node, specifier) => {
    if (isRuntimePackage(specifier)) {
      context.report({ node, message: message(packageNameOf(specifier)) });

      return;
    }

    if (specifier !== 'murmur') {
      return;
    }

    for (const named of namedRuntimeImports(node)) {
      const name = named.imported?.name ?? named.local?.name ?? '';
      context.report({ node: named, message: message(name) });
    }
  });
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description: 'tooling packages import the piece model only, never the bus runtime or app packages',
    },
    schema: [
      {
        type: 'object',
        properties: { allow: { type: 'array', items: { type: 'string' } } },
        additionalProperties: false,
      },
    ],
  },
  create,
} satisfies Rule;
