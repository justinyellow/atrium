import { passwordAllowed } from '../signinPolicy.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createSession, fail, hashPassword, randomToken, requireAdmin, requireUser, setSessionCookie, sha256 } from '../auth.js';
import { audit } from '../audit.js';
import { config } from '../config.js';
import { one, q } from '../db.js';
import {
  enqueue, getPrefs, PREF_KEYS, processOutbox, publicBase, runDigests, setPrefs, startEmailWorker, stopEmailWorker,
  verifySignature, workspaceName, type PrefKey, type PrefMode,
} from '../email.js';
import { inviteEmail, passwordChangedEmail, passwordResetEmail, testEmail, esc } from '../emailTemplates.js';

const RESET_TTL_MIN = 60;

/** Rate limit using the shared login_attempts table (works across instances). Returns true if allowed. */
async function allow(key: string, max: number) {
  const r = await one<{ n: number }>(`select count(*)::int as n from login_attempts where key = $1 and at > now() - interval '15 minutes'`, [key]);
  if ((r?.n ?? 0) >= max) return false;
  await q('insert into login_attempts(key) values ($1)', [key]);
  return true;
}

/** Queue the invite email for an invite that has an email address. */
export async function sendInviteEmail(token: string): Promise<boolean> {
  const inv = await one(
    `select i.*, u.name as inviter_name from invites i left join users u on u.id = i.created_by
     where i.token = $1 and i.used_at is null and i.expires_at > now()`,
    [token],
  );
  if (!inv?.email) return false;
  const r = inviteEmail({
    workspace: await workspaceName(),
    inviter: inv.inviter_name ?? null,
    role: inv.role,
    url: `${publicBase()}/invite/${token}`,
    expires: new Date(inv.expires_at),
  });
  await enqueue(inv.email, r, { kind: 'invite' });
  return true;
}

export async function sendPasswordChangedEmail(userId: string) {
  const u = await one('select email, name from users where id = $1', [userId]);
  if (!u?.email) return;
  await enqueue(u.email, passwordChangedEmail({ workspace: await workspaceName(), name: u.name, when: new Date(), url: `${publicBase()}/forgot` }), {
    kind: 'password_changed',
  });
}

const ip = (req: FastifyRequest) => req.ip;

export default async function emailRoutes(app: FastifyInstance) {
  startEmailWorker();
  app.addHook('onClose', async () => stopEmailWorker());

  // ----- password reset -----
  app.post<{ Body: { email?: string } }>('/auth/forgot', async (req) => {
    const email = String(req.body?.email ?? '').toLowerCase().trim();
    // Always the same response: no account enumeration.
    const ok = { ok: true, message: 'If an account exists for that email, a reset link is on its way.' };
    if (!email || !(await allow(`forgot:ip:${ip(req)}`, 10)) || !(await allow(`forgot:email:${email}`, 3))) return ok;
    const u = await one(
      `select u.id, u.name, u.email, u.signin_method, m.role from users u join workspace_members m on m.user_id = u.id
       where u.email = $1 and u.active`,
      [email],
    );
    if (!u) return ok;
    if (!passwordAllowed({ email: u.email, role: u.role, method: u.signin_method }).ok) return ok; // SSO account: the IdP handles recovery
    const token = randomToken(32);
    await q('delete from password_resets where user_id = $1 and used_at is null', [u.id]);
    await q(`insert into password_resets(token_hash, user_id, expires_at) values ($1,$2, now() + make_interval(mins => $3))`, [sha256(token), u.id, RESET_TTL_MIN]);
    await enqueue(u.email, passwordResetEmail({ workspace: await workspaceName(), name: u.name, url: `${publicBase()}/reset/${token}` }), { kind: 'password_reset' });
    await audit({ actorId: u.id, action: 'user.password_reset_requested', targetType: 'user', targetId: u.id, ip: ip(req) });
    return ok;
  });

  app.get<{ Params: { token: string } }>('/auth/reset/:token', async (req) => {
    const r = await one(
      `select u.email from password_resets pr join users u on u.id = pr.user_id
       where pr.token_hash = $1 and pr.used_at is null and pr.expires_at > now() and u.active`,
      [sha256(req.params.token)],
    );
    if (!r) fail(404, 'This reset link is invalid or has expired');
    return { email: r.email };
  });

  app.post<{ Body: { token?: string; password?: string } }>('/auth/reset', async (req, reply) => {
    const { token, password } = req.body ?? {};
    if (!(await allow(`reset:ip:${ip(req)}`, 20))) fail(429, 'Too many attempts — try again in a few minutes');
    if (!password || password.length < 8) fail(400, 'Password must be at least 8 characters');
    // Single use: claim the token atomically.
    const pr = await one<{ user_id: string }>(
      `update password_resets set used_at = now() where token_hash = $1 and used_at is null and expires_at > now() returning user_id`,
      [sha256(String(token ?? ''))],
    );
    if (!pr) fail(400, 'This reset link is invalid or has expired');
    const u = await one('select id, active from users where id = $1', [pr!.user_id]);
    if (!u?.active) fail(400, 'This account is deactivated');
    await q('update users set password_hash = $2 where id = $1', [u.id, await hashPassword(password!)]);
    await q('delete from sessions where user_id = $1', [u.id]); // sign out everywhere
    await q('delete from password_resets where user_id = $1 and used_at is null', [u.id]);
    await audit({ actorId: u.id, action: 'user.password_reset', targetType: 'user', targetId: u.id, ip: ip(req) });
    await sendPasswordChangedEmail(u.id);
    setSessionCookie(reply, await createSession(u.id));
    return { ok: true };
  });

  // ----- notification preferences -----
  app.get('/me/notification-prefs', async (req) => {
    const u = requireUser(req);
    return { prefs: await getPrefs(u.id), digestHour: config.email.digestHour, emailEnabled: config.email.driver !== 'log' };
  });
  app.put<{ Body: Partial<Record<PrefKey, PrefMode>> }>('/me/notification-prefs', async (req) => {
    const u = requireUser(req);
    return { prefs: await setPrefs(u.id, req.body ?? {}) };
  });

  // ----- one-click unsubscribe (public, signed) -----
  const unsubscribe = async (query: { u?: string; k?: string; s?: string }) => {
    const { u, k, s } = query;
    if (!u || !k || !s || !(k === 'digest' || PREF_KEYS.includes(k as PrefKey)) || !(await verifySignature(`${u}:${k}`, s))) return null;
    if (k === 'digest') {
      const prefs = await getPrefs(u);
      const patch: Partial<Record<PrefKey, PrefMode>> = {};
      for (const key of PREF_KEYS) if (prefs[key] === 'digest') patch[key] = 'off';
      await setPrefs(u, patch);
    } else {
      await setPrefs(u, { [k]: 'off' } as any);
    }
    return k;
  };
  app.get<{ Querystring: { u?: string; k?: string; s?: string } }>('/email/unsubscribe', async (req, reply) => {
    const k = await unsubscribe(req.query);
    const label = k === 'digest' ? 'daily digest' : k;
    reply.type('text/html; charset=utf-8');
    return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Email settings</title>
      <body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#37352f;max-width:420px;margin:15vh auto;padding:0 16px">
      <h1 style="font-size:22px">${k ? 'Unsubscribed' : 'Link not valid'}</h1>
      <p>${k ? `You won't get ${esc(label)} emails any more.` : 'This unsubscribe link is invalid.'} You can change this any time in Settings → Notifications.</p>
      <p><a href="${esc(publicBase())}/?settings=notifications" style="color:#2383e2">Open email settings</a></p></body>`;
  });
  // RFC 8058 one-click (mail clients POST to the List-Unsubscribe URL).
  app.post<{ Querystring: { u?: string; k?: string; s?: string } }>('/email/unsubscribe', async (req) => {
    if (!(await unsubscribe(req.query))) fail(400, 'Invalid link');
    return { ok: true };
  });

  // ----- invites -----
  app.post<{ Params: { token: string }; Body: { email?: string } }>('/invites/:token/send', async (req) => {
    const admin = requireAdmin(req);
    const inv = await one('select token, email from invites where token = $1 and workspace_id = $2 and used_at is null and expires_at > now()', [req.params.token, admin.workspaceId]);
    if (!inv) fail(404, 'Invite not found or expired');
    const email = req.body?.email?.trim().toLowerCase();
    if (email) {
      if (!/^[^@\s]+@[^@\s]+$/.test(email)) fail(400, 'Invalid email');
      if (inv.email && inv.email.toLowerCase() !== email) fail(400, `This invite is for ${inv.email}`);
      // Binding an email to a reusable link makes it single-person (used once on signup).
      if (!inv.email) await q('update invites set email = $2 where token = $1', [inv.token, email]);
    } else if (!inv.email) fail(400, 'Provide an email address to send this invite to');
    await sendInviteEmail(inv.token);
    await audit({ workspaceId: admin.workspaceId, actorId: admin.id, action: 'invite.emailed', targetType: 'invite', targetId: null, meta: { email: email ?? inv.email }, ip: ip(req) });
    return { ok: true };
  });

  // ----- admin -----
  app.post<{ Body: { to?: string } }>('/admin/email/test', async (req) => {
    const admin = requireAdmin(req);
    const to = req.body?.to?.trim() || admin.email;
    if (!/^[^@\s]+@[^@\s]+$/.test(to)) fail(400, 'Invalid email');
    await enqueue(to, testEmail({ workspace: await workspaceName(), driver: config.email.driver }), { kind: 'test' });
    await audit({ workspaceId: admin.workspaceId, actorId: admin.id, action: 'email.test_sent', meta: { to }, ip: ip(req) });
    // Try to deliver right away so the admin gets quick feedback (worker would pick it up anyway).
    await processOutbox(5).catch(() => {});
    const last = await one(`select status, last_error from email_outbox where kind = 'test' and to_addr = $1 order by id desc limit 1`, [to]);
    return { ok: last?.status !== 'failed', status: last?.status, error: last?.last_error ?? null, driver: config.email.driver };
  });

  app.post<{ Body: { userId?: string } }>('/admin/email/digest', async (req) => {
    requireAdmin(req);
    const queued = await runDigests({ force: true, userId: req.body?.userId });
    return { queued };
  });

  app.get('/admin/email/status', async (req) => {
    requireAdmin(req);
    const counts = await q(`select status, count(*)::int as n from email_outbox where created_at > now() - interval '7 days' group by status`);
    const recentFailures = await q(`select id, to_addr, subject, kind, attempts, last_error, created_at from email_outbox where status = 'failed' order by id desc limit 20`);
    return { driver: config.email.driver, from: config.email.from, counts: Object.fromEntries(counts.map((c) => [c.status, c.n])), recentFailures };
  });
}
