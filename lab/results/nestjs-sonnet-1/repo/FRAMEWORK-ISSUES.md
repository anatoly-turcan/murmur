# Framework issues

None encountered. No defect in NestJS 12 (`@nestjs/common`, `@nestjs/core`, `@nestjs/platform-express`, `@nestjs/cli`, `@nestjs/testing`) had to be worked around in the application code.

Notes:

* NestJS 12 is ESM-only, which forced the whole project to ESM (`"type": "module"`, `.js` extensions in relative imports, Jest run with `--experimental-vm-modules` and ts-jest's ESM preset). This is a constraint of the release, not a defect.
* Two choices that look like workarounds are deliberate design: the application is created with `bodyParser: false` and parses bodies itself so the specification's error precedence (`403` before `400`/`422` for a malformed body) can be honoured, and a filter turns Express's `404` for a wrong method on a known path into `405 method_not_allowed`. Both use documented public API.
