/**
 * OIDC single sign-on (Cognito-first, works with any OIDC provider) plus the shared
 * "apply IdP groups → Atrium role / groups / teamspaces" logic used by login and the Cognito sync job.
 *
 * Stateless across instances: login state (PKCE verifier, nonce) lives in Postgres.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { config } from './config.js';
import { one, q } from './db.js';
import { hashPassword, randomToken, workspaceId, type Role } from './auth.js';
import { audit } from './audit.js';
import { applyNewMemberDefaults } from './workspaceSettings.js';

const sso = config.sso;
const STATE_TTL_MIN = 10;

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  end_session_endpoint?: string;
}

let discoveryCache: { at: number; doc: Discovery; jwks: ReturnType<typeof createRemoteJWKSet> } | null = null;

export async function discovery() {
  if (discoveryCache && Date.now() - discoveryCache.at < 3600_000) return discoveryCache;
  const res = await fetch(`${sso.issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`OIDC discovery failed (${res.status})`);
  const doc = (await res.json()) as Discovery;
  if (doc.issuer.replace(/\/$/, '') !== sso.issuer) throw new Error(`OIDC issuer mismatch: expected ${sso.issuer}, got ${doc.issuer}`);
  discoveryCache = { at: Date.now(), doc, jwks: createRemoteJWKSet(new URL(doc.jwks_uri)) };
  return discoveryCache;
}

const b64url = (b: Buffer) => b.toString('base64url');

export function redirectUri(base: string) {
  return `${config.publicUrl ?? base}/api/v1/auth/sso/callback`;
}

/** Only allow same-site relative redirects after login. */
export function safeNext(next: unknown) {
  return typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : '/';
}

export async function startLogin(base: string, next?: string) {
  const { doc } = await discovery();
  const state = randomToken(24);
  const verifier = randomToken(48);
  const nonce = randomToken(24);
  await q('insert into sso_states(state, code_verifier, nonce, redirect_to) values ($1,$2,$3,$4)', [state, verifier, nonce, safeNext(next)]);
  q(`delete from sso_states where created_at < now() - interval '${STATE_TTL_MIN} minutes'`).catch(() => {});
  const p = new URLSearchParams({
    response_type: 'code',
    client_id: sso.clientId!,
    redirect_uri: redirectUri(base),
    scope: sso.scopes,
    state,
    nonce,
    code_challenge: b64url(createHash('sha256').update(verifier).digest()),
    code_challenge_method: 'S256',
  });
  if (sso.idpHint) p.set('identity_provider', sso.idpHint); // Cognito: go straight to Google
  return `${doc.authorization_endpoint}?${p}`;
}

export class SsoError extends Error {}

/** Exchange the code, validate the ID token, then find/link/create the user. Returns user id + redirect. */
export async function finishLogin(base: string, code: string, state: string, ip?: string) {
  const st = await one<{ code_verifier: string; nonce: string; redirect_to: string }>(
    `delete from sso_states where state = $1 and created_at > now() - interval '${STATE_TTL_MIN} minutes'
     returning code_verifier, nonce, redirect_to`,
    [state],
  );
  if (!st) throw new SsoError('Sign-in expired or was already used. Please try again.');
  const { doc, jwks } = await discovery();
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(base),
    client_id: sso.clientId!,
    code_verifier: st.code_verifier,
  });
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
  if (sso.clientSecret) headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(sso.clientId!)}:${encodeURIComponent(sso.clientSecret)}`).toString('base64')}`;
  const res = await fetch(doc.token_endpoint, { method: 'POST', headers, body, signal: AbortSignal.timeout(10_000) });
  const tok = (await res.json().catch(() => ({}))) as any;
  if (!res.ok || !tok.id_token) throw new SsoError(`Token exchange failed: ${tok.error_description ?? tok.error ?? res.status}`);

  let claims: JWTPayload & Record<string, any>;
  try {
    ({ payload: claims } = await jwtVerify(tok.id_token, jwks, { issuer: doc.issuer, audience: sso.clientId!, clockTolerance: 60 }));
  } catch (e: any) {
    throw new SsoError(`Invalid ID token: ${e.message}`);
  }
  if (claims.nonce !== st.nonce) throw new SsoError('Invalid ID token: nonce mismatch');
  if (claims.token_use !== undefined && claims.token_use !== 'id') throw new SsoError('Invalid ID token: token_use must be "id"');
  const userId = await upsertFromClaims(claims, ip);
  return { userId, next: st.redirect_to || '/' };
}

export function claimGroups(claims: Record<string, any>): string[] {
  const g = claims[sso.groupsClaim];
  if (Array.isArray(g)) return g.map(String);
  if (typeof g === 'string') return g.split(/[,\s]+/).filter(Boolean);
  return [];
}

export async function allowedDomains(): Promise<string[]> {
  const ws = await one<{ allowed_domains: string[] }>('select allowed_domains from workspaces order by created_at limit 1');
  return [...new Set([...sso.allowedDomains, ...(ws?.allowed_domains ?? []).map((d) => d.toLowerCase())])];
}

const emailVerified = (c: Record<string, any>) => c.email_verified === true || c.email_verified === 'true';

async function upsertFromClaims(c: JWTPayload & Record<string, any>, ip?: string): Promise<string> {
  const issuer = sso.issuer!;
  const sub = String(c.sub ?? '');
  if (!sub) throw new SsoError('ID token has no subject');
  const email = typeof c.email === 'string' ? c.email.toLowerCase().trim() : '';
  const verified = emailVerified(c);
  const name = (c.name as string) || [c.given_name, c.family_name].filter(Boolean).join(' ') || email.split('@')[0] || 'User';
  const username = (c['cognito:username'] as string) ?? (c.preferred_username as string) ?? null;
  const groups = claimGroups(c);
  const wsId = await workspaceId();
  if (!wsId) throw new SsoError('Workspace is not set up yet');

  // Shared pools (e.g. staff + customers + candidates): only members of an access group may sign in.
  if (sso.requiredGroups.length && !groups.some((g) => sso.requiredGroups.includes(g))) {
    await audit({ action: 'sso.login_rejected', meta: { email, reason: 'missing_access_group', groups }, ip });
    throw new SsoError("You don't have access to this workspace yet. Ask an admin to add you to an access group.");
  }

  let identity = await one<{ user_id: string }>('select user_id from user_identities where provider = $1 and subject = $2', [issuer, sub]);
  let userId = identity?.user_id;
  let created = false;

  if (!userId) {
    if (!email) throw new SsoError('Your identity provider did not share an email address');
    if (sso.requireEmailVerified && !verified) throw new SsoError('Your email address is not verified by the identity provider');
    const existing = await one<{ id: string }>('select id from users where email = $1', [email]);
    // Without a verified-email claim (e.g. Cognito federation that doesn't map email_verified), only link an
    // existing account by email when the email is on a trusted SSO domain — never for arbitrary domains.
    if (existing && !verified && !(await allowedDomains()).includes(email.split('@')[1] ?? '')) {
      await audit({ action: 'sso.login_rejected', meta: { email, reason: 'unverified_email_link' }, ip });
      throw new SsoError('This email is already registered with a password. Sign in with your password instead.');
    }
    if (existing) {
      userId = existing.id;
    } else {
      const domain = email.split('@')[1] ?? '';
      if (!sso.allowAnyDomain && !(await allowedDomains()).includes(domain)) {
        await audit({ action: 'sso.login_rejected', meta: { email, reason: 'domain_not_allowed' }, ip });
        throw new SsoError(`Accounts from ${domain} can't join this workspace. Ask an admin for an invite.`);
      }
      // SSO-provisioned users get an unguessable password hash (password login effectively disabled).
      const u = await one<{ id: string }>('insert into users(email, name, password_hash) values ($1,$2,$3) returning id', [
        email, name, await hashPassword(randomBytes(32).toString('hex')),
      ]);
      userId = u!.id;
      created = true;
    }
    await q(
      `insert into user_identities(user_id, provider, subject, email, username) values ($1,$2,$3,$4,$5)
       on conflict (provider, subject) do update set user_id = excluded.user_id`,
      [userId, issuer, sub, email || null, username],
    );
  }

  const user = await one<{ id: string; active: boolean; deactivated_by: string | null; email: string; name: string }>(
    'select id, active, deactivated_by, email, name from users where id = $1',
    [userId],
  );
  if (!user) throw new SsoError('Account not found');
  if (!user.active) {
    // The IdP just vouched for them; undo only deactivations that the IdP sync made.
    if (user.deactivated_by === 'sso') {
      await q('update users set active = true, deactivated_by = null where id = $1', [userId]);
      await audit({ actorId: userId, action: 'sso.user_reactivated', targetType: 'user', targetId: userId, ip });
    } else throw new SsoError('Your account has been deactivated. Contact a workspace admin.');
  }
  // Keep profile fresh from the IdP (email only when verified and not taken by someone else).
  if (name && name !== user.name) await q('update users set name = $2 where id = $1', [userId, name]);
  if (email && verified && email !== user.email && !(await one('select 1 from users where email = $1', [email]))) {
    await q('update users set email = $2 where id = $1', [userId, email]);
  }
  await q('update user_identities set last_login_at = now(), email = coalesce($3, email), username = coalesce($4, username) where provider = $1 and subject = $2', [
    issuer, sub, email || null, username,
  ]);

  const member = await one<{ role: Role }>('select role from workspace_members where user_id = $1 and workspace_id = $2', [userId, wsId]);
  if (!member) {
    const role = roleFor(groups);
    await q('insert into workspace_members(workspace_id, user_id, role) values ($1,$2,$3)', [wsId, userId, role]);
    await applyNewMemberDefaults(userId!, role);
    await audit({ workspaceId: wsId, actorId: userId, action: 'sso.user_provisioned', targetType: 'user', targetId: userId, meta: { email, created, groups }, ip });
  }
  await applyGroups(wsId, userId!, groups, 'login');
  await audit({ workspaceId: wsId, actorId: userId, action: 'sso.login', targetType: 'user', targetId: userId, meta: { groups }, ip });
  return userId!;
}

const ROLE_RANK: Record<string, number> = { guest: 1, member: 2, admin: 3 };

/** Highest role any of the user's IdP groups maps to, else the default role. */
export function roleFor(groups: string[], roleMap = sso.roleMap, defaultRole = sso.defaultRole): Role {
  let best: string | null = null;
  for (const g of groups) {
    const r = roleMap[g];
    if (r && ROLE_RANK[r] && (!best || ROLE_RANK[r] > ROLE_RANK[best])) best = r;
  }
  return (best ?? defaultRole) as Role;
}

/** IdP groups that should become Atrium groups (prefix filter) → { external name: display name }. */
export function syncedGroupNames(groups: string[], prefix = sso.groupPrefix): Map<string, string> {
  const out = new Map<string, string>();
  for (const g of groups) if (!prefix || g.startsWith(prefix)) out.set(g, prefix ? g.slice(prefix.length) || g : g);
  return out;
}

/**
 * Apply IdP group membership to role, IdP-managed Atrium groups and mapped teamspaces.
 * Owners are never changed. Only groups/teamspace memberships the IdP created are removed.
 */
export async function applyGroups(wsId: string, userId: string, groups: string[], via: 'login' | 'cognito_sync') {
  const changes: Record<string, unknown> = {};
  if (sso.roleSync) {
    const cur = await one<{ role: Role }>('select role from workspace_members where user_id = $1 and workspace_id = $2', [userId, wsId]);
    const next = roleFor(groups);
    if (cur && cur.role !== 'owner' && cur.role !== next) {
      await q('update workspace_members set role = $3 where user_id = $1 and workspace_id = $2', [userId, wsId, next]);
      changes.role = { from: cur.role, to: next };
    }
  }
  if (sso.groupSync) {
    const wanted = syncedGroupNames(groups);
    const added: string[] = [];
    for (const [ext, display] of wanted) {
      let g = await one<{ id: string }>(`select id from groups where workspace_id = $1 and source = 'sso' and external_id = $2`, [wsId, ext]);
      if (!g) g = await one<{ id: string }>(`insert into groups(workspace_id, name, source, external_id) values ($1,$2,'sso',$3) returning id`, [wsId, display, ext]);
      const r = await q('insert into group_members(group_id, user_id) values ($1,$2) on conflict do nothing returning group_id', [g!.id, userId]);
      if (r.length) added.push(display);
    }
    const removed = await q<{ name: string }>(
      `delete from group_members gm using groups g
       where gm.group_id = g.id and gm.user_id = $1 and g.workspace_id = $2 and g.source = 'sso' and not (g.external_id = any($3::text[]))
       returning g.name`,
      [userId, wsId, [...wanted.keys()]],
    );
    if (added.length || removed.length) changes.groups = { added, removed: removed.map((r) => r.name) };
  }
  const tsEntries = Object.entries(sso.teamspaceMap);
  if (tsEntries.length) {
    const tsAdded: string[] = [];
    const tsRemoved: string[] = [];
    for (const [idpGroup, ref] of tsEntries) {
      const ts = await one<{ id: string; name: string }>(
        `select id, name from teamspaces where workspace_id = $1 and (id::text = $2 or lower(name) = lower($2)) limit 1`,
        [wsId, ref],
      );
      if (!ts) continue;
      if (groups.includes(idpGroup)) {
        const r = await q(
          `insert into teamspace_members(teamspace_id, user_id, role, source) values ($1,$2,'member','sso') on conflict do nothing returning user_id`,
          [ts.id, userId],
        );
        if (r.length) tsAdded.push(ts.name);
      } else {
        // Only if no other mapped group still grants this teamspace.
        const stillGranted = tsEntries.some(([g, r]) => r === ref && g !== idpGroup && groups.includes(g));
        if (!stillGranted) {
          const r = await q(`delete from teamspace_members where teamspace_id = $1 and user_id = $2 and source = 'sso' returning user_id`, [ts.id, userId]);
          if (r.length) tsRemoved.push(ts.name);
        }
      }
    }
    if (tsAdded.length || tsRemoved.length) changes.teamspaces = { added: tsAdded, removed: tsRemoved };
  }
  if (Object.keys(changes).length) {
    await audit({ workspaceId: wsId, actorId: null, action: 'sso.group_sync', targetType: 'user', targetId: userId, meta: { via, ...changes } });
  }
  return changes;
}

/** Public, non-secret SSO status for the login page. */
export function publicSsoStatus() {
  return {
    enabled: sso.enabled,
    label: sso.buttonLabel,
    only: sso.enabled && sso.passwordPolicy === 'sso-only',
    passwordPolicy: sso.enabled ? sso.passwordPolicy : 'allow',
    domains: sso.enabled ? sso.allowedDomains : [],
    logoutUrl: sso.logoutUrl ?? null,
  };
}
