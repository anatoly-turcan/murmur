import { runRule } from '../../test/tester.ts';
import rule from './core-no-node.ts';

const filename = '/repo/packages/core/src/runtime/x.ts';
const message = 'core has zero node:* imports; move this to @murmur/node';

runRule('core-no-node', rule, {
  valid: [
    { code: "import { contract } from '../model/contract.ts'\nexport const c = contract", filename },
    { code: 'export const id = globalThis.crypto.randomUUID()', filename },
    {
      code: "import { readFileSync } from 'node:fs'\nexport const r = readFileSync",
      filename: '/repo/packages/node/src/x.ts',
    },
    { code: 'const o = { process: 1, Buffer: 2 }\nexport const p = o.process + o.Buffer', filename },
    { code: 'export function f(process: number) {\n  return process\n}', filename },
  ],
  invalid: [
    { code: "import fs from 'node:fs'\nexport const r = fs", filename, errors: [{ message }] },
    { code: "import path from 'path'\nexport const r = path", filename, errors: [{ message }] },
    { code: "export * from 'node:events'", filename, errors: 1 },
    { code: 'export const quit = () => process.exit(1)', filename, errors: [{ message }] },
    { code: "export const b = Buffer.from('')", filename, errors: 1 },
    { code: "export const r = require('x')", filename, errors: 1 },
    { code: 'export const p = globalThis.process', filename, errors: 1 },
  ],
});
