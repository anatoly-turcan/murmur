import { inApp, runRule } from '../../test/tester.ts';
import rule from './no-process-env.ts';

const piece = inApp('pieces/notify/send/piece.ts');
const message =
  'process.env is forbidden here; declare the key in `Piece({ config: { apiUrl: z.string() } })` and read `this.config.apiUrl` (set by murmur.yaml or MURMUR__<PIECE>__API_URL); a capability reads its own config';

runRule('no-process-env', rule, {
  valid: [
    { code: 'export const url = process.env.SMTP_URL', filename: inApp('murmur.config.ts') },
    { code: 'export const url = process.env.SMTP_URL', filename: inApp('capabilities/smtp/capability.ts') },
    { code: 'export const url = process.env.SMTP_URL', filename: inApp('pieces/notify/send/piece.test.ts') },
    { code: 'export const read = (ctx) => ctx.config.smtpUrl', filename: piece },
    { code: 'export const p = { process: { env: 1 } }.process.env', filename: piece },
  ],
  invalid: [
    { code: 'export const url = process.env.SMTP_URL', filename: piece, errors: [{ message, line: 1 }] },
    { code: "export const url = process['env'].SMTP_URL", filename: piece, errors: [{ message }] },
    { code: 'export const url = globalThis.process.env.SMTP_URL', filename: piece, errors: [{ message }] },
    { code: 'export const url = import.meta.env.SMTP_URL', filename: piece, errors: [{ message }] },
    { code: 'export const env = process.env', filename: inApp('src/util.ts'), errors: 1 },
  ],
});
