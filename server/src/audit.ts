import { q } from './db.js';

/**
 * Record a security-relevant action. Never throws (auditing must not break the action itself).
 * action: dotted verb, e.g. 'user.login', 'user.role_changed', 'page.permission_granted', 'sso.login'.
 */
export async function audit(entry: {
  workspaceId?: string | null;
  actorId?: string | null;
  action: string;
  targetType?: string;
  targetId?: string | null;
  meta?: Record<string, unknown>;
  ip?: string | null;
}) {
  try {
    await q(
      `insert into audit_log(workspace_id, actor_id, action, target_type, target_id, meta, ip)
       values (coalesce($1, (select id from workspaces order by created_at limit 1)), $2, $3, $4, $5, $6, $7)`,
      [entry.workspaceId ?? null, entry.actorId ?? null, entry.action, entry.targetType ?? null, entry.targetId ?? null, entry.meta ?? {}, entry.ip ?? null],
    );
  } catch (e: any) {
    console.error(JSON.stringify({ level: 'error', msg: 'audit write failed', err: e.message }));
  }
}
