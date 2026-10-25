import { auditCreated } from '../../audit/record.ts';
import { immediate } from '../../db/tx.ts';
import { recordOrgEvent } from '../../domain/org-events.ts';
import { chooseSlug } from '../../domain/slugs.ts';
import { throwIfInvalid } from '../../http/errors.ts';
import { created } from '../../http/respond.ts';
import type { Ctx, Result } from '../../http/types.ts';
import { validateBody } from '../../http/validate.ts';
import { ORG_FIELDS } from './fields.ts';
import { serializeOrganization } from './serialize.ts';
import { insertOrganization, orgSlugTaken } from './store.ts';

export function createOrganization(ctx: Ctx): Result {
  const { values, details } = validateBody(ctx.input().body, ORG_FIELDS, { required: ['name'] });
  throwIfInvalid(details);
  const me = ctx.me();

  return immediate(ctx.db, () => {
    const slug = chooseSlug(values.slug, values.name!, 'organization', (s) => orgSlugTaken(ctx.db, s));
    const org = insertOrganization(ctx.db, { name: values.name!, slug, plan: values.plan ?? 'free', ownerId: me.id }, ctx.now);
    auditCreated(ctx.db, ctx.now, { type: 'organization', id: org.id });
    const body = serializeOrganization(org);
    recordOrgEvent(ctx.db, ctx.now, me, {
      organizationId: org.id,
      type: 'organization.created',
      target: { type: 'organization', id: org.id },
      data: { organization: body },
    });

    return created(body, org.version);
  });
}
