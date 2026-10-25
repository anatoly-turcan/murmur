import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { run } from '../../db/sql.ts';
import { immediate } from '../../db/tx.ts';
import type { ActivityType, TargetType } from '../../domain/events.ts';
import type { Id, Role } from '../../domain/rows.ts';
import { newId } from '../../ids/uuid.ts';
import type { SeedResult, SeedUser } from '../../slices/types.ts';
import { emailKey } from '../../text/email.ts';
import { slugBase, slugKey } from '../../text/slug.ts';
import { issueApiKey } from '../api-keys/issue.ts';
import { backfillOrganizations } from '../organizations/backfill.ts';
import {
  between,
  chance,
  commentBody,
  createRng,
  days,
  memoFold,
  personName,
  pick,
  type Rng,
  sampleDistinct,
  SEED_CURRENCIES,
  seedLabels,
  shiftedDate,
  taskDescription,
  taskTitle,
  TIMEZONES,
} from './generators.ts';

const SIZES = {
  users: 2_000,
  showcase: 10,
  workspaces: 50,
  projectsPerWorkspace: 8,
  tasks: 100_000,
  bigProjectTasks: 2_000,
  commentsPattern: [1, 3, 5, 3],
};

const SHOWCASE_ROLES: readonly Role[] = ['admin', 'member', 'viewer'];

interface Seeder {
  db: DatabaseSync;
  rng: Rng;
  now: number;
  base: number;
}

interface PlannedMember {
  userIndex: number;
  role: Role;
}

interface SeedMember {
  userId: Id;
  role: Role;
}

interface SeedWorkspace {
  id: Id;
  ownerId: Id;
  members: SeedMember[];
  assignable: Id[];
}

interface SeedProject {
  id: Id;
  workspace: SeedWorkspace;
  taskCount: number;
}

interface TaskRef {
  id: Id;
  workspace: SeedWorkspace;
  createdAt: number;
}

function event(s: Seeder, workspaceId: Id, type: ActivityType, actorId: Id, target: TargetType, targetId: Id, at: number): void {
  run(
    s.db,
    `INSERT INTO activity_events (id, workspace_id, type, actor_id, target_type, target_id, changes, occurred_at) VALUES (?, ?, ?, ?, ?, ?, '{}', ?)`,
    newId(at),
    workspaceId,
    type,
    actorId,
    target,
    targetId,
    at,
  );
}

function insertUsers(s: Seeder): Id[] {
  const ids: Id[] = [];
  for (let i = 0; i < SIZES.users; i += 1) {
    const email = `seed.user${i + 1}@example.com`;
    const at = s.base + i * 1_000;
    const id = newId(at);
    ids.push(id);
    run(
      s.db,
      'INSERT INTO users (id, email, email_key, name, timezone, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id,
      email,
      emailKey(email),
      personName(i),
      TIMEZONES[i % TIMEZONES.length],
      at,
      at,
    );
  }

  return ids;
}

function showcaseMembers(w: number): PlannedMember[] {
  if (w >= SIZES.showcase) return [];
  const members: PlannedMember[] = [];
  for (let s = 0; s < SIZES.showcase; s += 1) {
    const distance = (w - s + SIZES.showcase) % SIZES.showcase;
    if (distance >= 1 && distance <= SHOWCASE_ROLES.length) members.push({ userIndex: s, role: SHOWCASE_ROLES[distance - 1] });
  }

  return members;
}

function randomRole(rng: Rng): Role {
  const roll = rng();
  if (roll < 0.1) return 'admin';

  return roll < 0.85 ? 'member' : 'viewer';
}

function memberPlan(s: Seeder, w: number, crowd: number[]): PlannedMember[] {
  const owner = w < SIZES.showcase ? w : pick(s.rng, crowd);
  const plan: PlannedMember[] = [{ userIndex: owner, role: 'owner' }, ...showcaseMembers(w)];
  const size = between(s.rng, 20, 80);
  const others = sampleDistinct(s.rng, crowd.filter((i) => i !== owner), size - plan.length);

  return [...plan, ...others.map((userIndex) => ({ userIndex, role: randomRole(s.rng) }))];
}

function insertWorkspace(s: Seeder, w: number, plan: PlannedMember[], userIds: Id[]): SeedWorkspace {
  const createdAt = s.base + days(1) + w * 60_000;
  const name = `Seed Workspace ${w + 1}`;
  const slug = slugBase(name, 'workspace');
  const ownerId = userIds[plan[0].userIndex];
  const id = newId(createdAt);
  run(
    s.db,
    'INSERT INTO workspaces (id, name, slug, slug_key, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    id,
    name,
    slug,
    slugKey(slug),
    ownerId,
    createdAt,
    createdAt,
  );
  event(s, id, 'workspace.created', ownerId, 'workspace', id, createdAt);
  const members = plan.map((m) => ({ userId: userIds[m.userIndex], role: m.role }));
  members.forEach((m, k) => insertMembership(s, id, ownerId, m, createdAt + k * 1_000));

  return { id, ownerId, members, assignable: members.filter((m) => m.role !== 'viewer').map((m) => m.userId) };
}

function insertMembership(s: Seeder, workspaceId: Id, ownerId: Id, member: SeedMember, joinedAt: number): void {
  run(s.db, 'INSERT INTO memberships (workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)', workspaceId, member.userId, member.role, joinedAt);
  if (member.role !== 'owner') event(s, workspaceId, 'member.added', ownerId, 'member', member.userId, joinedAt);
}

function insertWebhook(s: Seeder, ws: SeedWorkspace): void {
  const at = s.base + days(2);
  const id = newId(at);
  run(
    s.db,
    `INSERT INTO webhook_endpoints (id, workspace_id, url, events, secret, active, created_at, updated_at) VALUES (?, ?, ?, '["*"]', ?, 0, ?, ?)`,
    id,
    ws.id,
    'http://127.0.0.1:9/taskwell-seed',
    randomBytes(32).toString('hex'),
    at,
    at,
  );
  event(s, ws.id, 'webhook.created', ws.ownerId, 'webhook', id, at);
}

function insertWorkspaces(s: Seeder, userIds: Id[]): SeedWorkspace[] {
  const crowd = Array.from({ length: SIZES.users - SIZES.showcase }, (_, i) => i + SIZES.showcase);
  const workspaces: SeedWorkspace[] = [];
  for (let w = 0; w < SIZES.workspaces; w += 1) {
    const ws = insertWorkspace(s, w, memberPlan(s, w, crowd), userIds);
    insertWebhook(s, ws);
    workspaces.push(ws);
  }

  return workspaces;
}

function projectTaskCounts(): number[] {
  const total = SIZES.workspaces * SIZES.projectsPerWorkspace;
  const rest = SIZES.tasks - SIZES.bigProjectTasks;
  const each = Math.floor(rest / (total - 1));
  const remainder = rest - each * (total - 1);

  return Array.from({ length: total }, (_, i) => (i === 0 ? SIZES.bigProjectTasks : each + (i <= remainder ? 1 : 0)));
}

function insertProject(s: Seeder, ws: SeedWorkspace, index: number, taskCount: number): SeedProject {
  const at = s.base + days(2) + index * 60_000;
  const name = `Seed Project ${index + 1}`;
  const slug = slugBase(name, 'project');
  const creatorId = pick(s.rng, ws.assignable);
  const id = newId(at);
  run(
    s.db,
    `INSERT INTO projects (id, workspace_id, name, slug, slug_key, description, creator_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    ws.id,
    name,
    slug,
    slugKey(slug),
    `Reference dataset project ${index + 1}.`,
    creatorId,
    at,
    at,
  );
  event(s, ws.id, 'project.created', creatorId, 'project', id, at);

  return { id, workspace: ws, taskCount };
}

function insertProjects(s: Seeder, workspaces: SeedWorkspace[]): SeedProject[] {
  return projectTaskCounts().map((count, i) => insertProject(s, workspaces[Math.floor(i / SIZES.projectsPerWorkspace)], i, count));
}

function budget(rng: Rng): [string | null, string | null] {
  if (!chance(rng, 0.5)) return [null, null];
  const currency = pick(rng, SEED_CURRENCIES);

  return [currency.code, String(between(rng, 100, currency.maxMinor))];
}

function status(rng: Rng): 'open' | 'in_progress' | 'done' {
  const roll = rng();
  if (roll < 0.5) return 'open';

  return roll < 0.7 ? 'in_progress' : 'done';
}

function insertTask(s: Seeder, project: SeedProject, createdAt: number): TaskRef {
  const ws = project.workspace;
  const title = taskTitle(s.rng);
  const description = chance(s.rng, 0.5) ? taskDescription(s.rng) : null;
  const labels = seedLabels(s.rng);
  const state = status(s.rng);
  const [currency, minor] = budget(s.rng);
  const creatorId = pick(s.rng, ws.assignable);
  const id = newId(createdAt);
  run(
    s.db,
    `INSERT INTO tasks (id, project_id, workspace_id, title, title_fold, description, description_fold, status, labels, labels_fold,
       assignee_id, creator_id, due_date, estimate_minutes, budget_currency, budget_minor, completed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    project.id,
    ws.id,
    title,
    memoFold(title),
    description,
    description === null ? null : memoFold(description),
    state,
    JSON.stringify(labels),
    JSON.stringify(labels.map(memoFold)),
    chance(s.rng, 0.7) ? pick(s.rng, ws.assignable) : null,
    creatorId,
    chance(s.rng, 0.6) ? shiftedDate(s.now, between(s.rng, -180, 180)) : null,
    chance(s.rng, 0.5) ? between(s.rng, 15, 2_400) : null,
    currency,
    minor,
    state === 'done' ? createdAt + days(1) : null,
    createdAt,
    createdAt,
  );
  event(s, ws.id, 'task.created', creatorId, 'task', id, createdAt);

  return { id, workspace: ws, createdAt };
}

function insertComments(s: Seeder, task: TaskRef, count: number): void {
  for (let i = 0; i < count; i += 1) {
    const at = task.createdAt + Math.floor(s.rng() * Math.max(1, s.now - task.createdAt));
    const authorId = pick(s.rng, task.workspace.assignable);
    const body = commentBody(s.rng);
    const id = newId(at);
    run(
      s.db,
      'INSERT INTO comments (id, task_id, workspace_id, author_id, body, body_fold, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      task.id,
      task.workspace.id,
      authorId,
      body,
      memoFold(body),
      at,
      at,
    );
    event(s, task.workspace.id, 'comment.created', authorId, 'comment', id, at);
  }
}

function insertTasks(s: Seeder, projects: SeedProject[]): void {
  const start = s.base + days(3);
  const step = (s.now - days(1) - start) / SIZES.tasks;
  let n = 0;
  for (const project of projects) {
    for (let i = 0; i < project.taskCount; i += 1, n += 1) {
      const task = insertTask(s, project, Math.floor(start + n * step));
      insertComments(s, task, SIZES.commentsPattern[n % SIZES.commentsPattern.length]);
    }
  }
}

function showcaseUsers(s: Seeder, userIds: Id[], workspaces: SeedWorkspace[]): SeedUser[] {
  return userIds.slice(0, SIZES.showcase).map((userId, i) => ({
    email: `seed.user${i + 1}@example.com`,
    api_key: issueApiKey(s.db, userId, 'seed', s.now).secret,
    workspace_ids: workspaces.filter((w) => w.members.some((m) => m.userId === userId)).map((w) => w.id),
  }));
}

export function seedReference(db: DatabaseSync, now: number): SeedResult {
  const s: Seeder = { db, rng: createRng(20_260_301), now, base: now - days(400) };

  return immediate(db, () => {
    const userIds = insertUsers(s);
    const workspaces = insertWorkspaces(s, userIds);
    backfillOrganizations(db, now, 'business');
    insertTasks(s, insertProjects(s, workspaces));

    return { users: showcaseUsers(s, userIds, workspaces) };
  });
}
