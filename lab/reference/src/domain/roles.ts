import type { Role } from './rows.ts';

export type { Role } from './rows.ts';

export const ROLES: readonly Role[] = ['owner', 'admin', 'member', 'viewer'];

const RANK: Record<Role, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };

export function atLeast(role: Role | null, minimum: Role): boolean {
  return role !== null && RANK[role] >= RANK[minimum];
}

export function isAssignableRole(role: Role | null): boolean {
  return atLeast(role, 'member');
}
