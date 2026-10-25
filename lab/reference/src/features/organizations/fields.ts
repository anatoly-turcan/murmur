import { PLANS } from '../../domain/plans.ts';
import type { OrgRole } from '../../domain/rows.ts';
import { email, id, oneOf, slug, str, type FieldSpecs } from '../../http/validate.ts';

export const ADDABLE_ORG_ROLES: readonly OrgRole[] = ['org_admin', 'billing', 'org_member'];

export const ORG_FIELDS = { name: str({ max: 100 }), slug: slug(), plan: oneOf(PLANS) } satisfies FieldSpecs;

export const ORG_MEMBER_ADD_FIELDS = { email: email(), role: oneOf(ADDABLE_ORG_ROLES) } satisfies FieldSpecs;

export const ORG_ROLE_FIELDS = { role: oneOf(ADDABLE_ORG_ROLES) } satisfies FieldSpecs;

export const ORG_TRANSFER_FIELDS = { user_id: id() } satisfies FieldSpecs;
