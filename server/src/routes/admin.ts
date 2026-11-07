import { passwordAllowed, passwordAllowedForUser, type SigninMethod } from '../signinPolicy.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { fail, hashPassword, randomToken, requireAdmin, requireUser, sha256, type AuthUser } from '../auth.js';
import { one, q, tx } from '../db.js';
import { emit } from '../events.js';
import { audit } from '../audit.js';
import { sendEmail } from '../email.js';
import { config } from '../config.js';
import { assertPage, RANK, type Level } from '../perms.js';
import { applyNewMemberDefaults, assertCanInviteGuests, getSettings, updateSettings } from '../workspaceSettings.js';
import { startTrashPurge, purgeTrash } from '../jobs/trashPurge.js';

// ---------- helpers ----------

const ROLES = ['owner', 'admin', 'member', 'guest'] as const;
const EMAIL_RE = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;
const normEmail = (e: unknown) => String(e ?? '').trim().toLowerCase();

export function publicUrl(req: FastifyRequest) {
  if (config.publicUrl) return config.publicUrl;
  const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0].trim() ?? req.protocol;
  const host = (req.headers['x-forwarded-host'] as string | undefined)?.split(',')[0].trim() ?? req.headers.host;
  return `${proto}://${host}`;
}

const auditFrom = (req: FastifyRequest, actor: AuthUser, action: string, targetType?: string, targetId?: string | null, meta?: Record<string, unknown>) =>
  audit({ workspaceId: actor.workspaceId, actorId: actor.id, action, targetType, targetId, meta, ip: req.ip });

/** One-time password (re)set link, stored in the email agent's password_resets table. */
export async function createPasswordResetLink(req: FastifyRequest, userId: string, hours = 24) {
  const token = randomToken(24);
  await q(`insert into password_resets(token_hash, user_id, expires_at) values ($1,$2, now() + ($3 || ' hours')::interval)`, [
    sha256(token), userId, String(hours),
  ]);
  return `${publicUrl(req)}/reset/${token}`;
}

function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
function emailHtml(lines: string[], cta?: { label: string; url: string }) {
  return `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#37352f;max-width:520px;line-height:1.5">
${lines.map((l) => `<p>${esc(l)}</p>`).join('\n')}
${cta ? `<p><a href="${esc(cta.url)}" style="display:inline-block;background:#2383e2;color:#fff;padding:8px 16px;border-radius:6px;text-decoration:none">${esc(cta.label)}</a></p>
<p style="color:#787774;font-size:12px">Or paste this link into your browser: ${esc(cta.url)}</p>` : ''}
</div>`;
}

async function workspaceName(id: string) {
  return (await one('select name from workspaces where id = $1', [id]))?.name ?? 'Atrium';
}

function csv(rows: (string | number | null | undefined)[][]) {
  return rows
    .map((r) => r.map((v) => {
      const s = v == null ? '' : String(v);
      // Neutralise spreadsheet formula injection.
      const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
      return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
    }).join(','))
    .join('\r\n');
}

async function targetMember(admin: AuthUser, userId: string) {
  const t = await one(
    `select u.id, u.name, u.email, u.active, u.deleted_at, u.signin_method, m.role from users u join workspace_members m on m.user_id = u.id
     where u.id = $1 and m.workspace_id = $2`,
    [userId, admin.workspaceId],
  );
  if (!t) fail(404, 'User not found');
  return t;
}

async function ownerCount(wsId: string) {
  return (await one(`select count(*)::int n from workspace_members m join users u on u.id = m.user_id where m.workspace_id = $1 and m.role = 'owner' and u.active`, [wsId])).n as number;
}

/** Shared role-change rules (also used by the legacy PATCH /users/:id). */
export async function assertRoleChange(admin: AuthUser, target: { id: string; role: string }, next: string) {
  if (!ROLES.includes(next as any)) fail(400, 'Bad role');
  if (target.role === 'owner' && admin.role !== 'owner') fail(403, 'Only owners can change owners');
  if (next === 'owner' && admin.role !== 'owner') fail(403, 'Only owners can grant owner');
  if (target.role === 'owner' && next !== 'owner' && (await ownerCount(admin.workspaceId)) <= 1) fail(400, 'The workspace needs at least one owner');
  if (next === 'guest' && !(await getSettings(admin.workspaceId)).allow_guests) fail(400, 'Guests are disabled in workspace settings');
}

async function revokeAccess(userId: string, opts: { sessions?: boolean; apiTokens?: boolean; oauth?: boolean }) {
  const out: Record<string, number> = {};
  if (opts.sessions !== false) out.sessions = (await q('delete from sessions where user_id = $1 returning 1', [userId])).length;
  if (opts.apiTokens) out.apiTokens = (await q('delete from api_tokens where user_id = $1 returning 1', [userId])).length;
  if (opts.oauth) out.oauthGrants = (await q('update oauth_tokens set revoked_at = now() where user_id = $1 and revoked_at is null returning 1', [userId])).length;
  return out;
}

/** Creates (or reuses) an email-bound invite; optionally attaches page grants applied on signup. */
async function createEmailInvite(
  req: FastifyRequest, actor: AuthUser, email: string, role: string,
  opts: { days?: number; pageGrant?: { pageId: string; level: Level }; send?: boolean; message?: string } = {},
) {
  const existing = await one(
    `select token, page_grants from invites where workspace_id = $1 and lower(email) = $2 and used_at is null and expires_at > now() and role = $3
     order by created_at desc limit 1`,
    [actor.workspaceId, email, role],
  );
  let token: string;
  if (existing) {
    token = existing.token;
    if (opts.pageGrant) {
      const grants = (existing.page_grants as any[]).filter((g) => g.pageId !== opts.pageGrant!.pageId);
      await q('update invites set page_grants = $2 where token = $1', [token, JSON.stringify([...grants, opts.pageGrant])]);
    }
  } else {
    token = randomToken(18);
    await q(
      `insert into invites(token, workspace_id, role, email, created_by, expires_at, page_grants)
       values ($1,$2,$3,$4,$5, now() + ($6 || ' days')::interval, $7)`,
      [token, actor.workspaceId, role, email, actor.id, String(opts.days ?? 14), JSON.stringify(opts.pageGrant ? [opts.pageGrant] : [])],
    );
    await auditFrom(req, actor, 'invite.created', 'invite', null, { email, role, via: opts.pageGrant ? 'share' : 'admin' });
  }
  const url = `${publicUrl(req)}/invite/${token}`;
  let emailed = false;
  if (opts.send !== false) {
    const ws = await workspaceName(actor.workspaceId);
    const pageTitle = opts.pageGrant ? (await one('select title from pages where id = $1', [opts.pageGrant.pageId]))?.title || 'Untitled' : null;
    const subject = pageTitle ? `${actor.name} shared "${pageTitle}" with you` : `${actor.name} invited you to ${ws} on Atrium`;
    const lines = pageTitle
      ? [`${actor.name} invited you to collaborate on "${pageTitle}" in ${ws}.`, ...(opts.message ? [opts.message] : []), 'Create your account to open it:']
      : [`${actor.name} invited you to join ${ws} on Atrium.`, ...(opts.message ? [opts.message] : []), 'Accept the invite to create your account:'];
    emailed = await sendEmail({ to: email, subject, text: `${lines.join('\n\n')}\n\n${url}`, html: emailHtml(lines, { label: pageTitle ? 'Open page' : 'Join workspace', url }) });
  }
  return { token, url, emailed, reused: !!existing };
}

export default async function adminRoutes(app: FastifyInstance) {
  // ================= users =================
  app.get<{ Querystring: { q?: string; role?: string; status?: string; limit?: string; offset?: string } }>('/admin/users', async (req) => {
    const admin = requireAdmin(req);
    const { q: search, role, status = 'all' } = req.query;
    const limit = Math.min(Number(req.query.limit ?? 100), 500);
    const offset = Number(req.query.offset ?? 0);
    const where = `m.workspace_id = $1 and u.deleted_at is null
      and ($2::text is null or u.name ilike '%' || $2 || '%' or u.email ilike '%' || $2 || '%')
      and ($3::text is null or m.role = $3)
      and ($4 = 'all' or ($4 = 'active' and u.active) or ($4 = 'deactivated' and not u.active))`;
    const params = [admin.workspaceId, search || null, role || null, status];
    const [rows, total] = await Promise.all([
      q(
        `select u.id, u.name, u.email, u.avatar_url, u.active, u.signin_method, exists(select 1 from user_identities i where i.user_id = u.id) as sso_linked, m.role, m.created_at as joined_at, u.last_active_at,
           (select count(*)::int from sessions s where s.user_id = u.id and s.expires_at > now()) as session_count
         from users u join workspace_members m on m.user_id = u.id where ${where}
         order by u.name limit ${limit} offset ${offset}`,
        params,
      ),
      one(`select count(*)::int n from users u join workspace_members m on m.user_id = u.id where ${where}`, params),
    ]);
    return { users: rows, total: total.n, limit, offset };
  });

  app.get('/admin/users.csv', async (req, reply) => {
    const admin = requireAdmin(req);
    const rows = await q(
      `select u.name, u.email, m.role, case when u.active then 'active' else 'deactivated' end as status, m.created_at, u.last_active_at,
         coalesce((select string_agg(g.name, '; ' order by g.name) from group_members gm join groups g on g.id = gm.group_id where gm.user_id = u.id), '') as groups,
         coalesce((select string_agg(t.name, '; ' order by t.name) from teamspace_members tm join teamspaces t on t.id = tm.teamspace_id where tm.user_id = u.id), '') as teamspaces
       from users u join workspace_members m on m.user_id = u.id where m.workspace_id = $1 and u.deleted_at is null order by u.name`,
      [admin.workspaceId],
    );
    await auditFrom(req, admin, 'export.members_csv', 'workspace', admin.workspaceId, { rows: rows.length });
    reply.header('content-disposition', 'attachment; filename="members.csv"').type('text/csv; charset=utf-8');
    return csv([
      ['Name', 'Email', 'Role', 'Status', 'Joined', 'Last active', 'Groups', 'Teamspaces'],
      ...rows.map((r) => [r.name, r.email, r.role, r.status, new Date(r.created_at).toISOString(), r.last_active_at ? new Date(r.last_active_at).toISOString() : '', r.groups, r.teamspaces]),
    ]);
  });

  app.get<{ Params: { id: string } }>('/admin/users/:id', async (req) => {
    const admin = requireAdmin(req);
    const u = await one(
      `select u.id, u.name, u.email, u.avatar_url, u.active, u.signin_method, exists(select 1 from user_identities i where i.user_id = u.id) as sso_linked, u.created_at, u.last_active_at, m.role, m.created_at as joined_at
       from users u join workspace_members m on m.user_id = u.id where u.id = $1 and m.workspace_id = $2`,
      [req.params.id, admin.workspaceId],
    );
    if (!u) fail(404, 'User not found');
    const [groups, teamspaces, sessions, counts, tokens] = await Promise.all([
      q('select g.id, g.name from group_members gm join groups g on g.id = gm.group_id where gm.user_id = $1 order by g.name', [u.id]),
      q('select t.id, t.name, t.icon, tm.role from teamspace_members tm join teamspaces t on t.id = tm.teamspace_id where tm.user_id = $1 order by t.name', [u.id]),
      q(`select id, user_agent, ip, created_at, last_seen_at from sessions where user_id = $1 and expires_at > now() order by last_seen_at desc`, [u.id]),
      one(
        `select
           (select count(*)::int from pages where created_by = $1 and deleted_at is null and kind <> 'synced') as pages_created,
           (select count(*)::int from pages where owner_id = $1 and teamspace_id is null and parent_id is null and deleted_at is null and kind <> 'row') as private_roots,
           (select count(*)::int from comments where author_id = $1) as comments`,
        [u.id],
      ),
      one(
        `select (select count(*)::int from api_tokens where user_id = $1) as api_tokens,
           (select count(*)::int from oauth_tokens where user_id = $1 and revoked_at is null) as oauth_grants`,
        [u.id],
      ),
    ]);
    return { ...u, groups, teamspaces, sessions, counts, tokens };
  });

  app.post<{ Body: { name: string; email: string; role?: string; groups?: string[]; teamspaces?: string[]; sendEmail?: boolean; signinMethod?: SigninMethod } }>('/admin/users', async (req) => {
    const admin = requireAdmin(req);
    const b = req.body ?? ({} as any);
    const email = normEmail(b.email);
    const role = b.role ?? 'member';
    if (!b.name?.trim() || !EMAIL_RE.test(email)) fail(400, 'Name and a valid email are required');
    await assertRoleChange(admin, { id: '', role: 'member' }, role);
    const existing = await one('select id, deleted_at from users where email = $1', [email]);
    if (existing) fail(409, 'A user with this email already exists');
    const userId = await tx(async (c) => {
      // Random unusable password until they set one via the emailed link.
      const method = b.signinMethod && ['auto', 'sso', 'password'].includes(b.signinMethod) ? b.signinMethod : 'auto';
      const u = (await c.query('insert into users(email, name, password_hash, signin_method) values ($1,$2,$3,$4) returning id', [email, b.name.trim(), await hashPassword(randomToken(32)), method])).rows[0];
      await c.query('insert into workspace_members(workspace_id, user_id, role) values ($1,$2,$3)', [admin.workspaceId, u.id, role]);
      for (const g of b.groups ?? []) {
        await c.query('insert into group_members(group_id, user_id) select id, $2 from groups where id = $1 and workspace_id = $3 on conflict do nothing', [g, u.id, admin.workspaceId]);
      }
      for (const t of b.teamspaces ?? []) {
        await c.query(`insert into teamspace_members(teamspace_id, user_id, role) select id, $2, 'member' from teamspaces where id = $1 and workspace_id = $3 on conflict do nothing`, [t, u.id, admin.workspaceId]);
      }
      return u.id as string;
    });
    await applyNewMemberDefaults(userId, role);
    const usesPassword = (await passwordAllowedForUser(userId)).ok;
    // SSO accounts never get a password link — they just sign in with the identity provider.
    const url = usesPassword ? await createPasswordResetLink(req, userId, 24 * 7) : `${config.publicUrl ?? ''}/login`;
    let emailed = false;
    if (b.sendEmail !== false) {
      const ws = await workspaceName(admin.workspaceId);
      const lines = usesPassword
        ? [`${admin.name} created an Atrium account for you in ${ws}.`, 'Set your password to get started (the link is valid for 7 days):']
        : [`${admin.name} created an Atrium account for you in ${ws}.`, `Sign in with ${config.sso.buttonLabel.replace(/^Continue with /i, '')} — no password needed:`];
      emailed = await sendEmail({ to: email, subject: `Your ${ws} account on Atrium`, text: `${lines.join('\n\n')}\n\n${url}`, html: emailHtml(lines, { label: usesPassword ? 'Set your password' : 'Sign in', url }) });
    }
    await auditFrom(req, admin, 'user.created', 'user', userId, { email, role, groups: b.groups ?? [], teamspaces: b.teamspaces ?? [] });
    emit({ type: 'members' });
    return { id: userId, email, role, emailed, signin: usesPassword ? 'password' : 'sso', setPasswordUrl: usesPassword ? url : null };
  });

  app.patch<{ Params: { id: string }; Body: { name?: string; email?: string; role?: string; signinMethod?: SigninMethod } }>('/admin/users/:id', async (req) => {
    const admin = requireAdmin(req);
    const t = await targetMember(admin, req.params.id);
    const b = req.body ?? {};
    const changes: Record<string, unknown> = {};
    if (t.role === 'owner' && admin.role !== 'owner' && (b.name || b.email)) fail(403, 'Only owners can edit owners');
    if (b.name !== undefined) {
      if (!b.name.trim()) fail(400, 'Name cannot be empty');
      await q('update users set name = $2 where id = $1', [t.id, b.name.trim()]);
      changes.name = { from: t.name, to: b.name.trim() };
    }
    if (b.email !== undefined) {
      const email = normEmail(b.email);
      if (!EMAIL_RE.test(email)) fail(400, 'Invalid email');
      if (email !== t.email) {
        if (await one('select 1 from users where email = $1 and id <> $2', [email, t.id])) fail(409, 'Another user already uses this email');
        await q('update users set email = $2 where id = $1', [t.id, email]);
        // Old reset links were sent to the old address.
        await q('delete from password_resets where user_id = $1 and used_at is null', [t.id]).catch(() => {});
        changes.email = { from: t.email, to: email };
      }
    }
    if (b.role !== undefined && b.role !== t.role) {
      if (t.id === admin.id) fail(400, 'You cannot change your own role');
      await assertRoleChange(admin, t, b.role);
      await q('update workspace_members set role = $3 where user_id = $1 and workspace_id = $2', [t.id, admin.workspaceId, b.role]);
      changes.role = { from: t.role, to: b.role };
    }
    if (b.signinMethod !== undefined && b.signinMethod !== t.signin_method) {
      if (!['auto', 'sso', 'password'].includes(b.signinMethod)) fail(400, 'signinMethod must be auto, sso or password');
      await q('update users set signin_method = $2 where id = $1', [t.id, b.signinMethod]);
      changes.signinMethod = { from: t.signin_method, to: b.signinMethod };
      // Moving someone onto SSO ends their password sessions so the new rule applies immediately.
      if (!passwordAllowed({ email: t.email, role: t.role, method: b.signinMethod }).ok) await q('delete from sessions where user_id = $1', [t.id]);
    }
    if (Object.keys(changes).length) {
      await auditFrom(req, admin, changes.role ? 'user.role_changed' : 'user.updated', 'user', t.id, changes);
      emit({ type: 'members' });
    }
    return { ok: true, changes };
  });

  app.post<{ Params: { id: string }; Body: { sendEmail?: boolean } }>('/admin/users/:id/reset-password', async (req) => {
    const admin = requireAdmin(req);
    const t = await targetMember(admin, req.params.id);
    if (t.role === 'owner' && admin.role !== 'owner') fail(403, 'Only owners can reset an owner\'s password');
    if (!t.active) fail(400, 'Reactivate the user first');
    if (!passwordAllowed({ email: t.email, role: t.role, method: t.signin_method }).ok) fail(400, 'This person signs in with SSO — reset their access in the identity provider, or set their sign-in method to Password first');
    const url = await createPasswordResetLink(req, t.id, 24);
    let emailed = false;
    if (req.body?.sendEmail !== false) {
      const lines = [`${admin.name} sent you a link to reset your Atrium password.`, 'The link is valid for 24 hours:'];
      emailed = await sendEmail({ to: t.email, subject: 'Reset your Atrium password', text: `${lines.join('\n\n')}\n\n${url}`, html: emailHtml(lines, { label: 'Reset password', url }) });
    }
    await auditFrom(req, admin, 'user.password_reset_issued', 'user', t.id, { emailed });
    // Only return the link when it wasn't emailed (admin hands it over another way).
    return { ok: true, emailed, url: emailed ? undefined : url };
  });

  app.post<{ Params: { id: string }; Body: { apiTokens?: boolean; oauth?: boolean } }>('/admin/users/:id/logout', async (req) => {
    const admin = requireAdmin(req);
    const t = await targetMember(admin, req.params.id);
    if (t.role === 'owner' && admin.role !== 'owner') fail(403, 'Only owners can do this for an owner');
    const revoked = await revokeAccess(t.id, { sessions: true, apiTokens: !!req.body?.apiTokens, oauth: req.body?.oauth !== false });
    await auditFrom(req, admin, 'user.sessions_revoked', 'user', t.id, revoked);
    return { ok: true, revoked };
  });

  const setActive = async (req: FastifyRequest<{ Params: { id: string } }>, active: boolean) => {
    const admin = requireAdmin(req);
    const t = await targetMember(admin, req.params.id);
    if (t.id === admin.id) fail(400, 'You cannot deactivate yourself');
    if (t.role === 'owner' && admin.role !== 'owner') fail(403, 'Only owners can change owners');
    if (!active && t.role === 'owner' && (await ownerCount(admin.workspaceId)) <= 1) fail(400, 'The workspace needs at least one active owner');
    await q('update users set active = $2 where id = $1', [t.id, active]);
    if (!active) await revokeAccess(t.id, { sessions: true, apiTokens: false, oauth: true });
    await auditFrom(req, admin, active ? 'user.reactivated' : 'user.deactivated', 'user', t.id, { email: t.email });
    emit({ type: 'members' });
    return { ok: true };
  };
  app.post<{ Params: { id: string } }>('/admin/users/:id/deactivate', (req) => setActive(req, false));
  app.post<{ Params: { id: string } }>('/admin/users/:id/reactivate', (req) => setActive(req, true));

  /**
   * Offboard: transfer private pages to another member, remove access and memberships, anonymise contact details.
   * Authored content keeps its attribution (the user row stays, marked deleted).
   */
  app.delete<{ Params: { id: string }; Body: { transferTo: string; teamspaceId?: string | null; anonymiseName?: boolean }; Querystring: { transferTo?: string; teamspaceId?: string; anonymiseName?: string } }>('/admin/users/:id', async (req) => {
    const admin = requireAdmin(req);
    const t = await targetMember(admin, req.params.id);
    // Accept options as JSON body or query string (some clients can't send a DELETE body).
    const qs = req.query ?? {};
    const b: { transferTo?: string; teamspaceId?: string | null; anonymiseName?: boolean } = {
      transferTo: qs.transferTo, teamspaceId: qs.teamspaceId, anonymiseName: qs.anonymiseName === 'true', ...((req.body as any) ?? {}),
    };
    if (t.id === admin.id) fail(400, 'You cannot delete yourself');
    if (t.role === 'owner' && admin.role !== 'owner') fail(403, 'Only owners can delete owners');
    if (t.role === 'owner' && (await ownerCount(admin.workspaceId)) <= 1) fail(400, 'Cannot delete the last owner');
    if (!b.transferTo) fail(400, 'transferTo (the member who receives their private pages) is required');
    const recipient = await one(
      `select u.id, u.name, m.role from users u join workspace_members m on m.user_id = u.id
       where u.id = $1 and m.workspace_id = $2 and u.active and u.deleted_at is null`,
      [b.transferTo, admin.workspaceId],
    );
    if (!recipient || recipient.id === t.id) fail(400, 'Choose an active member to receive their pages');
    if (recipient.role === 'guest') fail(400, 'Pages cannot be transferred to a guest');
    if (b.teamspaceId && !(await one('select 1 from teamspaces where id = $1 and workspace_id = $2', [b.teamspaceId, admin.workspaceId]))) fail(400, 'Unknown teamspace');

    const result = await tx(async (c) => {
      const roots = (await c.query(
        `select id from pages where owner_id = $1 and teamspace_id is null and parent_id is null and deleted_at is null and kind not in ('row','synced')
         order by position`,
        [t.id],
      )).rows.map((r) => r.id as string);
      let containerId: string | null = null;
      if (roots.length) {
        const pos = (await c.query(
          b.teamspaceId
            ? 'select coalesce(max(position),0)+1 as p from pages where parent_id is null and teamspace_id = $1'
            : 'select coalesce(max(position),0)+1 as p from pages where parent_id is null and teamspace_id is null and owner_id = $1',
          [b.teamspaceId ?? recipient.id],
        )).rows[0].p;
        containerId = (await c.query(
          `insert into pages(workspace_id, parent_id, teamspace_id, owner_id, kind, title, icon, position, created_by, updated_by)
           values ($1, null, $2, $3, 'page', $4, '📦', $5, $6, $6) returning id`,
          [admin.workspaceId, b.teamspaceId ?? null, b.teamspaceId ? null : recipient.id, `From ${t.name}`, pos, admin.id],
        )).rows[0].id;
        await c.query(`update pages set parent_id = $1 where id = any($2::uuid[])`, [containerId, roots]);
      }
      // Everything they owned (incl. trashed and synced pages) moves with the private space.
      const moved = (await c.query(
        `update pages set owner_id = $2, teamspace_id = coalesce($3, teamspace_id) where owner_id = $1 and teamspace_id is null returning 1`,
        [t.id, b.teamspaceId ? null : recipient.id, b.teamspaceId ?? null],
      )).rowCount;
      if (b.teamspaceId) await c.query('update pages set owner_id = null where owner_id = $1', [t.id]);
      await c.query(`delete from page_permissions where principal_type = 'user' and principal_id = $1`, [t.id]);
      await c.query('delete from teamspace_members where user_id = $1', [t.id]);
      await c.query('delete from group_members where user_id = $1', [t.id]);
      await c.query('delete from favorites where user_id = $1', [t.id]);
      await c.query('delete from page_visits where user_id = $1', [t.id]);
      await c.query('delete from notifications where user_id = $1', [t.id]);
      await c.query('delete from sessions where user_id = $1', [t.id]);
      await c.query('delete from api_tokens where user_id = $1', [t.id]);
      await c.query('update oauth_tokens set revoked_at = now() where user_id = $1 and revoked_at is null', [t.id]);
      await c.query('delete from password_resets where user_id = $1', [t.id]).catch(() => {});
      await c.query('delete from workspace_members where user_id = $1 and workspace_id = $2', [t.id, admin.workspaceId]);
      await c.query(
        `update users set email = $2, avatar_url = null, password_hash = $3, active = false, deleted_at = now(),
           name = case when $4 then 'Former member' else name end where id = $1`,
        [t.id, `deleted+${t.id}@invalid.local`, await hashPassword(randomToken(32)), !!b.anonymiseName],
      );
      return { containerId, transferredRoots: roots.length, pagesReassigned: moved };
    });
    await auditFrom(req, admin, 'user.deleted', 'user', t.id, { email: t.email, name: t.name, transferTo: recipient.id, teamspaceId: b.teamspaceId ?? null, ...result });
    emit({ type: 'members' });
    emit({ type: 'tree' });
    return { ok: true, ...result };
  });

  // ================= invites =================
  app.post<{ Body: { emails?: string[] | string; csv?: string; role?: string; days?: number; sendEmail?: boolean; message?: string } }>('/admin/invites/bulk', async (req) => {
    const admin = requireAdmin(req);
    const b = req.body ?? {};
    const role = b.role ?? 'member';
    if (!['admin', 'member', 'guest'].includes(role)) fail(400, 'Bad role');
    if (role === 'guest' && !(await getSettings(admin.workspaceId)).allow_guests) fail(400, 'Guests are disabled in workspace settings');
    const raw = [
      ...(Array.isArray(b.emails) ? b.emails : typeof b.emails === 'string' ? [b.emails] : []),
      b.csv ?? '',
    ].join('\n');
    // Accept "a@x.com, b@y.com", one per line, or CSV with an email column anywhere.
    const tokens = raw.split(/[\s,;]+/).map((s) => s.replace(/^["'<(]+|[">')]+$/g, '').trim()).filter(Boolean);
    const seen = new Set<string>();
    const results: { email: string; status: 'invited' | 'already_member' | 'invalid' | 'duplicate' | 'already_invited'; url?: string; emailed?: boolean }[] = [];
    for (const tok of tokens) {
      if (!tok.includes('@')) continue; // header cells, names
      const email = normEmail(tok);
      if (!EMAIL_RE.test(email)) { results.push({ email, status: 'invalid' }); continue; }
      if (seen.has(email)) { results.push({ email, status: 'duplicate' }); continue; }
      seen.add(email);
      if (results.length >= 500) fail(400, 'At most 500 emails per request');
      const member = await one(
        `select 1 from users u join workspace_members m on m.user_id = u.id where u.email = $1 and m.workspace_id = $2`,
        [email, admin.workspaceId],
      );
      if (member) { results.push({ email, status: 'already_member' }); continue; }
      const r = await createEmailInvite(req, admin, email, role, { days: b.days, send: b.sendEmail, message: b.message });
      results.push({ email, status: r.reused ? 'already_invited' : 'invited', url: r.url, emailed: r.emailed });
    }
    await auditFrom(req, admin, 'invite.bulk', 'workspace', admin.workspaceId, {
      role, invited: results.filter((r) => r.status === 'invited').length, total: results.length,
    });
    return { results, summary: Object.fromEntries(['invited', 'already_invited', 'already_member', 'invalid', 'duplicate'].map((s) => [s, results.filter((r) => r.status === s).length])) };
  });

  // Share-to-email: invite someone who isn't a member yet as a guest on one page.
  app.post<{ Params: { id: string }; Body: { email: string; level?: Level; message?: string } }>('/pages/:id/invite-guest', async (req) => {
    const user = requireUser(req);
    await assertPage(user, req.params.id, 'full');
    const email = normEmail(req.body?.email);
    const level = req.body?.level ?? 'view';
    if (!EMAIL_RE.test(email)) fail(400, 'Enter a valid email address');
    if (!(level in RANK) || level === 'none') fail(400, 'Bad level');
    const page = await one('select kind from pages where id = $1', [req.params.id]);
    if (page?.kind === 'synced') fail(400, 'Cannot share this block');
    const existing = await one(
      `select u.id, u.active from users u join workspace_members m on m.user_id = u.id where u.email = $1 and m.workspace_id = $2 and u.deleted_at is null`,
      [email, user.workspaceId],
    );
    if (existing) {
      // Already in the workspace: grant directly (same path as the Share menu).
      const ex = await one(`select id from page_permissions where page_id = $1 and principal_type = 'user' and principal_id = $2`, [req.params.id, existing.id]);
      if (ex) await q('update page_permissions set level = $2 where id = $1', [ex.id, level]);
      else await q(`insert into page_permissions(page_id, principal_type, principal_id, level) values ($1,'user',$2,$3)`, [req.params.id, existing.id, level]);
      await auditFrom(req, user, 'page.permission_granted', 'page', req.params.id, { principal_type: 'user', principal_id: existing.id, level });
      emit({ type: 'tree' });
      return { ok: true, status: 'granted', userId: existing.id };
    }
    await assertCanInviteGuests(user);
    const r = await createEmailInvite(req, user, email, 'guest', { pageGrant: { pageId: req.params.id, level }, message: req.body?.message });
    await auditFrom(req, user, 'page.guest_invited', 'page', req.params.id, { email, level });
    return { ok: true, status: 'invited', url: r.url, emailed: r.emailed };
  });

  // ================= sessions (self-service) =================
  app.get('/me/sessions', async (req) => {
    const user = requireUser(req);
    const rows = await q(
      `select id, user_agent, ip, created_at, last_seen_at, expires_at from sessions where user_id = $1 and expires_at > now() order by last_seen_at desc`,
      [user.id],
    );
    return rows.map((s) => ({ ...s, current: s.id === user.sessionId }));
  });
  app.delete<{ Params: { id: string } }>('/me/sessions/:id', async (req) => {
    const user = requireUser(req);
    const r = await q('delete from sessions where id = $1 and user_id = $2 returning 1', [req.params.id, user.id]);
    if (!r.length) fail(404, 'Session not found');
    await auditFrom(req, user, 'session.revoked', 'session', req.params.id, { self: true });
    return { ok: true };
  });
  app.post('/me/sessions/logout-others', async (req) => {
    const user = requireUser(req);
    const r = await q('delete from sessions where user_id = $1 and id is distinct from $2 returning 1', [user.id, user.sessionId ?? null]);
    await auditFrom(req, user, 'session.revoked_others', 'user', user.id, { count: r.length });
    return { ok: true, count: r.length };
  });

  // ================= audit log =================
  const auditQuery = (req: FastifyRequest<{ Querystring: Record<string, string | undefined> }>, admin: AuthUser) => {
    const f = req.query;
    const where = `a.workspace_id = $1
      and ($2::uuid is null or a.actor_id = $2)
      and ($3::text is null or a.action = $3 or a.action like $3 || '.%')
      and ($4::text is null or a.target_id = $4)
      and ($5::timestamptz is null or a.created_at >= $5)
      and ($6::timestamptz is null or a.created_at < $6)
      and ($7::text is null or a.target_type = $7)`;
    return { where, params: [admin.workspaceId, f.actor || null, f.action || null, f.target || null, f.from || null, f.to || null, f.targetType || null] };
  };
  app.get<{ Querystring: Record<string, string | undefined> }>('/admin/audit', async (req) => {
    const admin = requireAdmin(req);
    const { where, params } = auditQuery(req, admin);
    const limit = Math.min(Number(req.query.limit ?? 100), 500);
    const offset = Number(req.query.offset ?? 0);
    const [rows, total, actions] = await Promise.all([
      q(
        `select a.id, a.action, a.target_type, a.target_id, a.meta, a.ip, a.created_at,
           case when a.actor_id is null then null else json_build_object('id', u.id, 'name', u.name, 'email', u.email, 'avatar_url', u.avatar_url) end as actor,
           case when a.target_type = 'page' then (select title from pages where id::text = a.target_id)
                when a.target_type = 'user' then (select name from users where id::text = a.target_id)
                when a.target_type = 'teamspace' then (select name from teamspaces where id::text = a.target_id)
                when a.target_type = 'group' then (select name from groups where id::text = a.target_id)
                when a.target_type = 'workspace' then (select name from workspaces where id::text = a.target_id)
                when a.target_type = 'invite' then a.meta->>'email'
                when a.target_type = 'token' then a.meta->>'name'
                when a.target_type = 'oauth_client' then coalesce(a.meta->>'client_name', (select name from oauth_clients where client_id = a.target_id)) end as target_label
         from audit_log a left join users u on u.id = a.actor_id where ${where}
         order by a.created_at desc, a.id desc limit ${limit} offset ${offset}`,
        params,
      ),
      one(`select count(*)::int n from audit_log a where ${where}`, params),
      q(`select distinct action from audit_log where workspace_id = $1 order by action`, [admin.workspaceId]),
    ]);
    return { entries: rows, total: total.n, limit, offset, actions: actions.map((a) => a.action) };
  });
  app.get<{ Querystring: Record<string, string | undefined> }>('/admin/audit.csv', async (req, reply) => {
    const admin = requireAdmin(req);
    const { where, params } = auditQuery(req, admin);
    const rows = await q(
      `select a.created_at, u.name as actor_name, u.email as actor_email, a.action, a.target_type, a.target_id, a.ip, a.meta
       from audit_log a left join users u on u.id = a.actor_id where ${where} order by a.created_at desc limit 50000`,
      params,
    );
    await auditFrom(req, admin, 'export.audit_csv', 'workspace', admin.workspaceId, { rows: rows.length });
    reply.header('content-disposition', 'attachment; filename="audit-log.csv"').type('text/csv; charset=utf-8');
    return csv([
      ['Time', 'Actor', 'Actor email', 'Action', 'Target type', 'Target id', 'IP', 'Details'],
      ...rows.map((r) => [new Date(r.created_at).toISOString(), r.actor_name ?? 'System', r.actor_email ?? '', r.action, r.target_type, r.target_id, r.ip, JSON.stringify(r.meta)]),
    ]);
  });

  // ================= workspace security settings =================
  // Readable by every member so the UI can hide disabled actions; only admins change them.
  app.get('/workspace/settings', async (req) => {
    const user = requireUser(req);
    return getSettings(user.workspaceId);
  });
  app.patch<{ Body: Record<string, unknown> }>('/admin/settings', async (req) => {
    const admin = requireAdmin(req);
    const { changed, settings } = await updateSettings(admin.workspaceId, req.body ?? {});
    if (Object.keys(changed).length) await auditFrom(req, admin, 'workspace.settings_changed', 'workspace', admin.workspaceId, changed);
    emit({ type: 'members' });
    return settings;
  });

  // ================= trash retention =================
  app.post('/admin/trash/purge', async (req) => {
    const admin = requireAdmin(req);
    const r = await purgeTrash(config.trashRetentionDays);
    await auditFrom(req, admin, 'trash.purged', 'workspace', admin.workspaceId, { ...r, manual: true });
    return r;
  });
  startTrashPurge(app);
}
