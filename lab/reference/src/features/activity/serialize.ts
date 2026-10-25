import { actorRef } from '../../domain/actor.ts';
import type { ActivityRow } from '../../domain/rows.ts';
import { iso } from '../../time/format.ts';

export interface ActivityWithActor extends ActivityRow {
  actor_name: string;
  actor_deactivated_at: number | null;
}

export const ACTIVITY_SELECT = `SELECT e.*, u.name AS actor_name, u.deactivated_at AS actor_deactivated_at
  FROM activity_events e JOIN users u ON u.id = e.actor_id`;

export function serializeActivity(e: ActivityWithActor): Record<string, unknown> {
  return {
    id: e.id,
    workspace_id: e.workspace_id,
    type: e.type,
    actor: actorRef({ id: e.actor_id, name: e.actor_name, deactivated_at: e.actor_deactivated_at }),
    target: { type: e.target_type, id: e.target_id },
    changes: JSON.parse(e.changes),
    occurred_at: iso(e.occurred_at),
  };
}
