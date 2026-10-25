import { slug, str, type FieldSpecs } from '../../http/validate.ts';

export const WORKSPACE_FIELDS = {
  name: str({ max: 100 }),
  slug: slug(),
} satisfies FieldSpecs;
