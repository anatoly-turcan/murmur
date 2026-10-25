import { bool, email, str, timezone, type FieldSpecs } from '../../http/validate.ts';

export const USER_NAME = str({ max: 100 });

export const REGISTER_FIELDS = {
  email: email(),
  name: USER_NAME,
  timezone: timezone(),
} satisfies FieldSpecs;

export const USER_PATCH_FIELDS = {
  name: USER_NAME,
  timezone: timezone(),
  digest_enabled: bool(),
} satisfies FieldSpecs;
