import type { DatabaseSync } from 'node:sqlite';
import { auditCreated } from '../../audit/record.ts';
import { adoptActor } from '../../audit/context.ts';
import { one, run } from '../../db/sql.ts';
import { immediate } from '../../db/tx.ts';
import { loadUser } from '../../domain/actor.ts';
import { conflict, throwIfInvalid } from '../../http/errors.ts';
import { created } from '../../http/respond.ts';
import type { Ctx, Result } from '../../http/types.ts';
import { validateBody } from '../../http/validate.ts';
import { emailKey } from '../../text/email.ts';
import { issueApiKey } from '../api-keys/issue.ts';
import { serializeApiKey } from '../api-keys/serialize.ts';
import { REGISTER_FIELDS } from './fields.ts';
import { serializeUser } from './serialize.ts';
import { newId, type Id } from '../../ids/uuid.ts';

export function emailTaken(db: DatabaseSync, email: string): boolean {
  return one(db, 'SELECT 1 AS x FROM users WHERE email_key = ? AND deactivated_at IS NULL', emailKey(email)) !== undefined;
}

function insertUser(db: DatabaseSync, email: string, name: string, timezone: string, now: number): Id {
  const id = newId(now);
  run(
    db,
    'INSERT INTO users (id, email, email_key, name, timezone, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    id,
    email,
    emailKey(email),
    name,
    timezone,
    now,
    now,
  );

  return id;
}

export function register(ctx: Ctx): Result {
  const { values, details } = validateBody(ctx.input().body, REGISTER_FIELDS, { required: ['email', 'name'] });
  throwIfInvalid(details);
  const email = values.email!;

  return immediate(ctx.db, () => {
    if (emailTaken(ctx.db, email)) throw conflict('email_taken', 'This email address is already registered.');
    const userId = insertUser(ctx.db, email, values.name!, values.timezone ?? 'UTC', ctx.now);
    adoptActor(loadUser(ctx.db, userId)!);
    auditCreated(ctx.db, ctx.now, { type: 'user', id: userId });
    const key = issueApiKey(ctx.db, userId, 'default', ctx.now);
    auditCreated(ctx.db, ctx.now, { type: 'api_key', id: key.row.id });

    return created({ user: serializeUser(loadUser(ctx.db, userId)!), api_key: serializeApiKey(key.row, key.secret) });
  });
}
