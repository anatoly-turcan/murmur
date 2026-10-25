import { nullable, slug, str, type FieldSpecs } from '../../http/validate.ts';

export const PROJECT_FIELDS = {
  name: str({ max: 100 }),
  slug: slug(),
  description: nullable(str({ min: 0, max: 5000 })),
} satisfies FieldSpecs;
