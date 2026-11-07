import type { FastifyInstance } from 'fastify';
import { fail, randomToken, requireAdmin, requireUser } from '../auth.js';
import { one, q } from '../db.js';
import { emit } from '../events.js';
import { sendInviteEmail } from './email.js';
import { audit } from '../audit.js';
import { visibleUsers } from '../userVisibility.js';
import { assertRoleChange } from './admin.js';
import { getSettings } from '../workspaceSettings.js';
import type { FastifyRequest } from 'fastify';
import type { AuthUser } from '../auth.js';

const log = (req: FastifyRequest, u: AuthUser, action: string, targetType: string, targetId: string | null, meta?: Record<string, unknown>) =>
  audit({ workspaceId: u.workspaceId, actorId: u.id, action, targetType, targetId, meta, ip: req.ip });

export default async function workspaceRoutes(app: FastifyInstance) {
  app.patch<{ Body: { name?: string; icon?: string | null } }>('/workspace', async (req) => {
    const u = requireAdmin(req);
    await q('update workspaces set name = coalesce($2, name), icon = case when $3 then $4 else icon end where id = $1', [
      u.workspaceId, req.body?.name ?? null, req.body?.icon !== undefined, req.body?.icon ?? null,
    ]);
    await log(req, u, 'workspace.updated', 'workspace', u.workspaceId, { name: req.body?.name, icon: req.body?.icon });
    emit({ type: 'members' });
    return { ok: true };
  });

  // Guests only see people they collaborate with, without emails (see userVisibility.ts).
  app.get('/users', async (req) => visibleUsers(requireUser(req)));

  app.patch<{ Params: { id: string }; Body: { role?: string; active?: boolean } }>('/users/:id', async (req) => {
    const admin = requireAdmin(req);
    const target = await one('select user_id as id, role from workspace_members where user_id = $1 and workspace_id = $2', [req.params.id, admin.workspaceId]);
    if (!target) fail(404, 'User not found');
    if (target.role === 'owner' && admin.role !== 'owner') fail(403, 'Only owners can change owners');
    if (req.body?.role && req.body.role !== target.role) {
      if (req.params.id === admin.id) fail(400, 'You cannot change your own role');
      await assertRoleChange(admin, target, req.body.role);
      await q('update workspace_members set role = $3 where user_id = $1 and workspace_id = $2', [req.params.id, admin.workspaceId, req.body.role]);
      await log(req, admin, 'user.role_changed', 'user', req.params.id, { role: { from: target.role, to: req.body.role } });
    }
    if (req.body?.active !== undefined) {
      if (req.params.id === admin.id) fail(400, 'You cannot deactivate yourself');
      if (!req.body.active && target.role === 'owner') {
        const n = await one(`select count(*)::int n from workspace_members m join users u on u.id = m.user_id where m.workspace_id = $1 and m.role = 'owner' and u.active`, [admin.workspaceId]);
        if (n.n <= 1) fail(400, 'The workspace needs at least one active owner');
      }
      await q('update users set active = $2 where id = $1', [req.params.id, req.body.active]);
      if (!req.body.active) {
        await q('delete from sessions where user_id = $1', [req.params.id]);
        await q('update oauth_tokens set revoked_at = now() where user_id = $1 and revoked_at is null', [req.params.id]);
      }
      await log(req, admin, req.body.active ? 'user.reactivated' : 'user.deactivated', 'user', req.params.id);
    }
    emit({ type: 'members' });
    return { ok: true };
  });

  // ----- invites -----
  app.get('/invites', async (req) => {
    const u = requireAdmin(req);
    return q(`select token, email, role, created_at, expires_at from invites where workspace_id = $1 and used_at is null and expires_at > now() order by created_at desc`, [u.workspaceId]);
  });
  app.post<{ Body: { email?: string; role?: string; days?: number } }>('/invites', async (req) => {
    const u = requireAdmin(req);
    const role = req.body?.role ?? 'member';
    if (!['admin', 'member', 'guest'].includes(role)) fail(400, 'Bad role');
    if (role === 'guest' && !(await getSettings(u.workspaceId)).allow_guests) fail(400, 'Guests are disabled in workspace settings');
    const token = randomToken(18);
    await q(`insert into invites(token, workspace_id, role, email, created_by, expires_at) values ($1,$2,$3,$4,$5, now() + ($6 || ' days')::interval)`, [
      token, u.workspaceId, role, req.body?.email || null, u.id, String(req.body?.days ?? 14),
    ]);
    // Invites addressed to someone are emailed automatically (queued; never blocks the request).
    const emailed = req.body?.email ? await sendInviteEmail(token).catch(() => false) : false;
    await log(req, u, 'invite.created', 'invite', null, { email: req.body?.email || null, role, emailed });
    return { token, url: `/invite/${token}`, emailed };
  });
  app.delete<{ Params: { token: string } }>('/invites/:token', async (req) => {
    const u = requireAdmin(req);
    const gone = await q('delete from invites where token = $1 and workspace_id = $2 returning email, role', [req.params.token, u.workspaceId]);
    if (gone.length) await log(req, u, 'invite.revoked', 'invite', null, gone[0]);
    return { ok: true };
  });

  // ----- groups -----
  app.get('/groups', async (req) => {
    const u = requireUser(req);
    if (u.role === 'guest') return []; // guests don't see the org's group structure
    return q(
      `select g.id, g.name, coalesce(json_agg(json_build_object('id', us.id, 'name', us.name, 'avatar_url', us.avatar_url)) filter (where us.id is not null), '[]') as members
       from groups g left join group_members gm on gm.group_id = g.id left join users us on us.id = gm.user_id
       where g.workspace_id = $1 group by g.id order by g.name`,
      [u.workspaceId],
    );
  });
  app.post<{ Body: { name: string } }>('/groups', async (req) => {
    const u = requireAdmin(req);
    const g = await one('insert into groups(workspace_id, name) values ($1,$2) returning *', [u.workspaceId, req.body?.name || 'New group']);
    await log(req, u, 'group.created', 'group', g.id, { name: g.name });
    return g;
  });
  app.patch<{ Params: { id: string }; Body: { name?: string; members?: string[] } }>('/groups/:id', async (req) => {
    const u = requireAdmin(req);
    const g = await one('select id from groups where id = $1 and workspace_id = $2', [req.params.id, u.workspaceId]);
    if (!g) fail(404, 'Group not found');
    if (req.body?.name) await q('update groups set name = $2 where id = $1', [g.id, req.body.name]);
    if (req.body?.members) {
      const before = (await q('select user_id from group_members where group_id = $1', [g.id])).map((r) => r.user_id as string);
      await q('delete from group_members where group_id = $1', [g.id]);
      for (const m of req.body.members) await q('insert into group_members(group_id, user_id) values ($1,$2) on conflict do nothing', [g.id, m]);
      const added = req.body.members.filter((m) => !before.includes(m));
      const removed = before.filter((m) => !req.body!.members!.includes(m));
      if (added.length || removed.length) await log(req, u, 'group.members_changed', 'group', g.id, { added, removed });
    }
    if (req.body?.name) await log(req, u, 'group.renamed', 'group', g.id, { name: req.body.name });
    emit({ type: 'tree' });
    return { ok: true };
  });
  app.delete<{ Params: { id: string } }>('/groups/:id', async (req) => {
    const u = requireAdmin(req);
    const gone = await q('delete from groups where id = $1 and workspace_id = $2 returning name', [req.params.id, u.workspaceId]);
    if (gone.length) await log(req, u, 'group.deleted', 'group', req.params.id, { name: gone[0].name });
    emit({ type: 'tree' });
    return { ok: true };
  });

  // ----- teamspaces -----
  app.get('/teamspaces', async (req) => {
    const u = requireUser(req);
    return q(
      `select t.*, m.role as my_role,
         coalesce((select json_agg(json_build_object('id', us.id, 'name', us.name, 'avatar_url', us.avatar_url, 'role', tm.role))
           from teamspace_members tm join users us on us.id = tm.user_id where tm.teamspace_id = t.id), '[]') as members
       from teamspaces t left join teamspace_members m on m.teamspace_id = t.id and m.user_id = $2
       where t.workspace_id = $1 order by t.position, t.created_at`,
      [u.workspaceId, u.id],
    );
  });
  app.post<{ Body: { name: string; icon?: string; description?: string; is_default?: boolean } }>('/teamspaces', async (req) => {
    const u = requireUser(req);
    if (u.role === 'guest') fail(403, 'Guests cannot create teamspaces');
    const t = await one(
      `insert into teamspaces(workspace_id, name, icon, description, is_default, position)
       values ($1,$2,$3,$4,$5,(select coalesce(max(position),0)+1 from teamspaces where workspace_id = $1)) returning *`,
      [u.workspaceId, req.body?.name || 'New teamspace', req.body?.icon ?? '📁', req.body?.description ?? null, !!req.body?.is_default],
    );
    await q(`insert into teamspace_members(teamspace_id, user_id, role) values ($1,$2,'owner')`, [t.id, u.id]);
    await log(req, u, 'teamspace.created', 'teamspace', t.id, { name: t.name, is_default: t.is_default });
    emit({ type: 'tree' });
    return t;
  });
  const canManageTs = async (userId: string, role: string, tsId: string) => {
    if (role === 'owner' || role === 'admin') return true;
    const m = await one(`select role from teamspace_members where teamspace_id = $1 and user_id = $2`, [tsId, userId]);
    return m?.role === 'owner';
  };
  app.patch<{ Params: { id: string }; Body: any }>('/teamspaces/:id', async (req) => {
    const u = requireUser(req);
    if (!(await canManageTs(u.id, u.role, req.params.id))) fail(403, 'Only teamspace owners can change settings');
    const b: any = req.body ?? {};
    await q(
      `update teamspaces set name = coalesce($2, name), icon = coalesce($3, icon), description = coalesce($4, description),
         is_default = coalesce($5, is_default), default_level = coalesce($6, default_level) where id = $1`,
      [req.params.id, b.name ?? null, b.icon ?? null, b.description ?? null, b.is_default ?? null, b.default_level ?? null],
    );
    await log(req, u, 'teamspace.updated', 'teamspace', req.params.id, { name: b.name, is_default: b.is_default, default_level: b.default_level });
    emit({ type: 'tree' });
    return { ok: true };
  });
  app.put<{ Params: { id: string; uid: string }; Body: { role?: string } }>('/teamspaces/:id/members/:uid', async (req) => {
    const u = requireUser(req);
    const ts = await one('select is_default from teamspaces where id = $1', [req.params.id]);
    const self = req.params.uid === u.id && (ts?.is_default || (await canManageTs(u.id, u.role, req.params.id)));
    if (!self && !(await canManageTs(u.id, u.role, req.params.id))) fail(403, 'Only teamspace owners can add members');
    await q(
      `insert into teamspace_members(teamspace_id, user_id, role) values ($1,$2,$3)
       on conflict (teamspace_id, user_id) do update set role = excluded.role`,
      [req.params.id, req.params.uid, req.body?.role === 'owner' ? 'owner' : 'member'],
    );
    await log(req, u, 'teamspace.member_added', 'teamspace', req.params.id, { userId: req.params.uid, role: req.body?.role === 'owner' ? 'owner' : 'member' });
    emit({ type: 'tree' });
    return { ok: true };
  });
  app.delete<{ Params: { id: string; uid: string } }>('/teamspaces/:id/members/:uid', async (req) => {
    const u = requireUser(req);
    if (req.params.uid !== u.id && !(await canManageTs(u.id, u.role, req.params.id))) fail(403, 'Only teamspace owners can remove members');
    await q('delete from teamspace_members where teamspace_id = $1 and user_id = $2', [req.params.id, req.params.uid]);
    await log(req, u, 'teamspace.member_removed', 'teamspace', req.params.id, { userId: req.params.uid });
    emit({ type: 'tree' });
    return { ok: true };
  });
  app.delete<{ Params: { id: string } }>('/teamspaces/:id', async (req) => {
    const u = requireUser(req);
    if (!(await canManageTs(u.id, u.role, req.params.id))) fail(403, 'Only teamspace owners can delete it');
    await q('update pages set deleted_at = now(), deleted_by = $2 where teamspace_id = $1 and deleted_at is null', [req.params.id, u.id]);
    const gone = await q('delete from teamspaces where id = $1 returning name', [req.params.id]);
    if (gone.length) await log(req, u, 'teamspace.deleted', 'teamspace', req.params.id, { name: gone[0].name });
    emit({ type: 'tree' });
    return { ok: true };
  });
}
