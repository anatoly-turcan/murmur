import { registerHooks } from 'node:module';

import { appRootOf, loadWith, resolveHelpersFor } from './hooks.ts';
import { loadTransform, transformerName } from './transform.ts';

const transform = await loadTransform(transformerName(process.env['MURMUR_TRANSFORM']));
const root = appRootOf(import.meta.url, process.cwd());

process.setSourceMapsEnabled(true);
registerHooks({ resolve: resolveHelpersFor(root), load: loadWith(root, transform) });
