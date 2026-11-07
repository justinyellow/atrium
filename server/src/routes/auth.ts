import { passwordAllowed } from '../signinPolicy.js';
import type { FastifyInstance } from 'fastify';
import {
  checkPassword, createSession, fail, hashPassword, randomToken, requireUser, setSessionCookie, sha256,
  SESSION_COOKIE, workspaceId,
} from '../auth.js';
import { one, q, tx } from '../db.js';
import { createPage } from './pages.js';
import { loadUser } from '../auth.js';
import { audit } from '../audit.js';
import { sendPasswordChangedEmail } from './email.js';
import { applyNewMemberDefaults } from '../workspaceSettings.js';
import { config } from '../config.js';
import { publicSsoStatus } from '../sso.js';

const WELCOME = `Welcome to your new workspace. Here are the basics:

- Type \`/\` anywhere to insert blocks: headings, to-dos, toggles, callouts, code, tables, databases and more.
- Type \`@\` to mention a person or link another page.
- Drag the ⋮⋮ handle to move blocks around.
- Press **Ctrl/⌘ + K** to search everything.
- Click **Share** in the top-right to invite people to a page.

## Try it out

- [ ] Create a page in the sidebar
- [ ] Make a database with \`/database\`
- [ ] Invite a teammate from Settings → Members
`;

export default async function authRoutes(app: FastifyInstance) {
  app.get('/auth/status', async (req) => {
    const ws = await one('select id, name, icon from workspaces order by created_at limit 1');
    return { setupRequired: !ws, setupTokenRequired: !!process.env.SETUP_TOKEN, workspace: ws ?? null, user: req.user ?? null, sso: publicSsoStatus() };
  });

  app.post<{ Body: { name: string; email: string; password: string; workspaceName: string } }>('/auth/setup', async (req, reply) => {
    if (await workspaceId()) fail(400, 'Already set up');
    const { name, email, password, workspaceName, setupToken } = (req.body ?? {}) as any;
    // On a hosted instance, only someone holding SETUP_TOKEN can claim the owner account.
    if (process.env.SETUP_TOKEN && setupToken !== process.env.SETUP_TOKEN) fail(403, 'Invalid setup token');
    if (!name || !email || !password || password.length < 8) fail(400, 'Name, email and a password of 8+ characters are required');
    const userId = await tx(async (c) => {
      const ws = (await c.query('insert into workspaces(name) values ($1) returning id', [workspaceName || `${name}'s Workspace`])).rows[0];
      const u = (await c.query('insert into users(email, name, password_hash) values ($1,$2,$3) returning id', [email.toLowerCase().trim(), name, await hashPassword(password)])).rows[0];
      await c.query(`insert into workspace_members(workspace_id, user_id, role) values ($1,$2,'owner')`, [ws.id, u.id]);
      const ts = (await c.query(`insert into teamspaces(workspace_id, name, icon, is_default) values ($1,'General','🏠',true) returning id`, [ws.id])).rows[0];
      await c.query(`insert into teamspace_members(teamspace_id, user_id, role) values ($1,$2,'owner')`, [ts.id, u.id]);
      return u.id;
    });
    const user = (await loadUser(userId, 'session'))!;
    const ts = await one('select id from teamspaces where workspace_id = $1', [user.workspaceId]);
    await createPage(user, { teamspaceId: ts.id, title: 'Getting Started', icon: '👋', markdown: WELCOME });
    setSessionCookie(reply, await createSession(userId, req));
    await audit({ workspaceId: user.workspaceId, actorId: userId, action: 'workspace.created', targetType: 'workspace', targetId: user.workspaceId, ip: req.ip });
    return { ok: true };
  });

  app.post<{ Body: { email: string; password: string } }>('/auth/login', async (req, reply) => {
    const { email, password } = req.body ?? ({} as any);
    const key = `${req.ip}|${String(email ?? '').toLowerCase()}`;
    // Stored in Postgres so the limit holds across instances (ECS tasks).
    const recent = await one<{ n: number }>(
      `select count(*)::int as n from login_attempts where key = $1 and at > now() - interval '15 minutes'`,
      [key],
    );
    if ((recent?.n ?? 0) >= 10) fail(429, 'Too many attempts — try again in a few minutes');
    const u = await one(
      'select u.id, u.email, u.password_hash, u.active, u.signin_method, m.role from users u left join workspace_members m on m.user_id = u.id where u.email = $1',
      [String(email ?? '').toLowerCase().trim()],
    );
    if (!u || !u.active || !(await checkPassword(password ?? '', u.password_hash))) {
      await q('insert into login_attempts(key) values ($1)', [key]);
      q(`delete from login_attempts where at < now() - interval '1 day'`).catch(() => {});
      await audit({ actorId: u?.id ?? null, action: 'user.login_failed', targetType: 'user', targetId: u?.id ?? null, meta: { email: String(email ?? '').toLowerCase().trim(), reason: !u ? 'unknown_email' : !u.active ? 'deactivated' : 'bad_password' }, ip: req.ip });
      fail(401, 'Incorrect email or password');
    }
    await q('delete from login_attempts where key = $1', [key]);
    const policy = passwordAllowed({ email: u.email, role: u.role, method: u.signin_method });
    if (!policy.ok) {
      await audit({ actorId: u.id, action: 'user.login_failed', targetType: 'user', targetId: u.id, meta: { reason: 'sso_required' }, ip: req.ip });
      return reply.status(403).send({ error: policy.reason, sso: true });
    }
    setSessionCookie(reply, await createSession(u.id, req));
    await audit({ actorId: u.id, action: 'user.login', targetType: 'user', targetId: u.id, meta: { method: 'password' }, ip: req.ip });
    return { ok: true };
  });

  app.post('/auth/logout', async (req, reply) => {
    const t = req.cookies[SESSION_COOKIE];
    if (t) await q('delete from sessions where token = $1', [sha256(t)]);
    if (req.user) await audit({ workspaceId: req.user.workspaceId, actorId: req.user.id, action: 'user.logout', targetType: 'user', targetId: req.user.id, ip: req.ip });
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    // Optional IdP logout (e.g. Cognito /logout?client_id=…&logout_uri=…) so the next sign-in re-prompts.
    return { ok: true, redirect: config.sso.enabled ? config.sso.logoutUrl ?? null : null };
  });

  app.get<{ Params: { token: string } }>('/auth/invite/:token', async (req) => {
    const inv = await one(
      `select i.email, i.role, w.name as workspace_name from invites i join workspaces w on w.id = i.workspace_id
       where i.token = $1 and i.used_at is null and i.expires_at > now()`,
      [req.params.token],
    );
    if (!inv) fail(404, 'This invite link is invalid or has expired');
    return inv;
  });

  app.post<{ Body: { token: string; name: string; email: string; password: string } }>('/auth/signup', async (req, reply) => {
    const { token, name, email, password } = req.body ?? ({} as any);
    const inv = await one('select * from invites where token = $1 and used_at is null and expires_at > now()', [token]);
    if (!inv) fail(400, 'This invite link is invalid or has expired');
    {
      const policy = passwordAllowed({ email: String(inv.email || email || ''), role: inv.role });
      if (!policy.ok) return reply.status(403).send({ error: policy.reason, sso: true });
    }
    if (!name || !email || !password || password.length < 8) fail(400, 'Name, email and a password of 8+ characters are required');
    const em = email.toLowerCase().trim();
    if (inv.email && inv.email.toLowerCase() !== em) fail(400, `This invite is for ${inv.email}`);
    if (await one('select 1 from users where email = $1', [em])) fail(400, 'An account with this email already exists — log in instead');
    const userId = await tx(async (c) => {
      const u = (await c.query('insert into users(email, name, password_hash) values ($1,$2,$3) returning id', [em, name, await hashPassword(password)])).rows[0];
      await c.query('insert into workspace_members(workspace_id, user_id, role) values ($1,$2,$3)', [inv.workspace_id, u.id, inv.role]);
      if (inv.email) await c.query('update invites set used_at = now() where token = $1', [token]);
      // Guest invites from the Share menu carry the page access to grant on acceptance.
      for (const g of (inv.page_grants ?? []) as { pageId: string; level: string }[]) {
        await c.query(
          `insert into page_permissions(page_id, principal_type, principal_id, level) select $1, 'user', $2, $3
           where exists (select 1 from pages where id = $1 and deleted_at is null) on conflict do nothing`,
          [g.pageId, u.id, g.level],
        );
      }
      return u.id;
    });
    await applyNewMemberDefaults(userId, inv.role);
    setSessionCookie(reply, await createSession(userId, req));
    await audit({ workspaceId: inv.workspace_id, actorId: userId, action: 'invite.accepted', targetType: 'user', targetId: userId, meta: { email: em, role: inv.role, invitedBy: inv.created_by, pageGrants: (inv.page_grants ?? []).length }, ip: req.ip });
    return { ok: true };
  });

  app.get('/me', async (req) => {
    const u = requireUser(req);
    const ws = await one('select id, name, icon from workspaces where id = $1', [u.workspaceId]);
    return { ...u, workspace: ws };
  });

  app.patch<{ Body: { name?: string; avatar_url?: string | null; theme?: string; password?: string; currentPassword?: string } }>('/me', async (req) => {
    const u = requireUser(req);
    const b = req.body ?? {};
    if (b.password) {
      const row = await one('select password_hash from users where id = $1', [u.id]);
      if (!(await checkPassword(b.currentPassword ?? '', row.password_hash))) fail(400, 'Current password is incorrect');
      if (b.password.length < 8) fail(400, 'Password must be at least 8 characters');
      await q('update users set password_hash = $2 where id = $1', [u.id, await hashPassword(b.password)]);
      await audit({ workspaceId: u.workspaceId, actorId: u.id, action: 'user.password_changed', targetType: 'user', targetId: u.id, ip: req.ip });
      await sendPasswordChangedEmail(u.id);
    }
    await q(
      'update users set name = coalesce($2, name), avatar_url = case when $3::boolean then $4 else avatar_url end, theme = coalesce($5, theme) where id = $1',
      [u.id, b.name ?? null, b.avatar_url !== undefined, b.avatar_url ?? null, b.theme ?? null],
    );
    return { ok: true };
  });

  // ----- API tokens -----
  app.get('/tokens', async (req) => {
    const u = requireUser(req);
    return q('select id, name, prefix, created_at, last_used_at from api_tokens where user_id = $1 order by created_at desc', [u.id]);
  });
  app.post<{ Body: { name: string } }>('/tokens', async (req) => {
    const u = requireUser(req);
    if (u.via === 'token') fail(403, 'Tokens cannot create tokens');
    const token = `atr_${randomToken(24)}`;
    const r = await one('insert into api_tokens(user_id, name, token_hash, prefix) values ($1,$2,$3,$4) returning id, name, prefix, created_at', [
      u.id, req.body?.name || 'Integration', sha256(token), token.slice(0, 10),
    ]);
    await audit({ workspaceId: u.workspaceId, actorId: u.id, action: 'token.created', targetType: 'token', targetId: r.id, meta: { name: r.name, prefix: r.prefix }, ip: req.ip });
    return { ...r, token };
  });
  app.delete<{ Params: { id: string } }>('/tokens/:id', async (req) => {
    const u = requireUser(req);
    const gone = await q('delete from api_tokens where id = $1 and user_id = $2 returning name', [req.params.id, u.id]);
    if (gone.length) await audit({ workspaceId: u.workspaceId, actorId: u.id, action: 'token.revoked', targetType: 'token', targetId: req.params.id, meta: { name: gone[0].name }, ip: req.ip });
    return { ok: true };
  });
}
