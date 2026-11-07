import type { FastifyInstance, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { createSession, fail, randomToken, requireAdmin, setSessionCookie, sha256 } from '../auth.js';
import { one, q, runAsLeader } from '../db.js';
import { audit } from '../audit.js';
import { allowedDomains, finishLogin, redirectUri, safeNext, SsoError, startLogin } from '../sso.js';
import { awsCognitoApi, runCognitoSync } from '../jobs/cognitoSync.js';

/** Base URL as the browser sees it (PUBLIC_URL wins; else forwarded headers behind ALB/nginx). */
function baseUrl(req: FastifyRequest) {
  if (config.publicUrl) return config.publicUrl;
  const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0].trim() ?? req.protocol;
  const host = (req.headers['x-forwarded-host'] as string | undefined)?.split(',')[0].trim() ?? req.headers.host;
  return `${proto}://${host}`;
}

const loginError = (msg: string) => `/login?sso_error=${encodeURIComponent(msg)}`;

export default async function ssoRoutes(app: FastifyInstance) {
  const s = config.sso;

  app.get<{ Querystring: { next?: string } }>('/auth/sso/login', async (req, reply) => {
    if (!s.enabled) return reply.redirect(loginError('Single sign-on is not enabled'));
    try {
      return reply.redirect(await startLogin(baseUrl(req), req.query.next));
    } catch (e: any) {
      req.log.error(e, 'sso login start failed');
      return reply.redirect(loginError('Could not reach the sign-in provider. Try again shortly.'));
    }
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string; error_description?: string } }>('/auth/sso/callback', async (req, reply) => {
    if (!s.enabled) return reply.redirect(loginError('Single sign-on is not enabled'));
    const { code, state, error, error_description } = req.query;
    if (error) return reply.redirect(loginError(error_description || error));
    if (!code || !state) return reply.redirect(loginError('Sign-in response was incomplete'));
    try {
      const { userId, next } = await finishLogin(baseUrl(req), code, state, req.ip);
      setSessionCookie(reply, await createSession(userId, req));
      return reply.redirect(safeNext(next));
    } catch (e: any) {
      if (!(e instanceof SsoError)) req.log.error(e, 'sso callback failed');
      return reply.redirect(loginError(e instanceof SsoError ? e.message : 'Sign-in failed'));
    }
  });

  // ----- admin: status & settings -----
  app.get('/sso/settings', async (req) => {
    const admin = requireAdmin(req);
    const [domains, ws, lastRun, linked, tokens] = await Promise.all([
      allowedDomains(),
      one('select allowed_domains from workspaces where id = $1', [admin.workspaceId]),
      one('select started_at, finished_at, dry_run, result from sso_sync_runs order by id desc limit 1'),
      one<{ n: number }>('select count(*)::int as n from user_identities where provider = $1', [s.issuer ?? '']),
      q(`select id, name, prefix, created_at, last_used_at from scim_tokens where workspace_id = $1 and revoked_at is null order by created_at desc`, [admin.workspaceId]),
    ]);
    return {
      sso: {
        enabled: s.enabled, issuer: s.issuer ?? null, clientId: s.clientId ?? null, clientSecretSet: !!s.clientSecret,
        scopes: s.scopes, idpHint: s.idpHint ?? null, buttonLabel: s.buttonLabel, only: s.only,
        redirectUri: redirectUri(baseUrl(req)), logoutUrl: s.logoutUrl ?? null,
        requireEmailVerified: s.requireEmailVerified, allowAnyDomain: s.allowAnyDomain,
        groupsClaim: s.groupsClaim, roleMap: s.roleMap, defaultRole: s.defaultRole, roleSync: s.roleSync,
        groupSync: s.groupSync, groupPrefix: s.groupPrefix, teamspaceMap: s.teamspaceMap, linkedUsers: linked?.n ?? 0,
      },
      domains: { effective: domains, env: s.allowedDomains, workspace: ws?.allowed_domains ?? [] },
      cognito: {
        userPoolId: s.cognito.userPoolId ?? null, region: s.cognito.region, intervalMinutes: s.cognito.syncIntervalMinutes,
        dryRun: s.cognito.dryRun, maxDeactivatePct: s.cognito.maxDeactivatePct, lastRun: lastRun ?? null,
      },
      scim: { baseUrl: `${baseUrl(req)}/scim/v2`, tokens },
    };
  });

  app.patch<{ Body: { allowed_domains?: string[] } }>('/sso/settings', async (req) => {
    const admin = requireAdmin(req);
    const raw = req.body?.allowed_domains;
    if (!Array.isArray(raw)) fail(400, 'allowed_domains must be a list');
    const domains = [...new Set(raw!.map((d) => String(d).trim().toLowerCase().replace(/^@/, '')).filter(Boolean))];
    if (domains.some((d) => !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d))) fail(400, 'Invalid domain');
    await q('update workspaces set allowed_domains = $2 where id = $1', [admin.workspaceId, domains]);
    await audit({ workspaceId: admin.workspaceId, actorId: admin.id, action: 'sso.allowed_domains_changed', meta: { domains }, ip: req.ip });
    return { ok: true, domains };
  });

  // ----- admin: SCIM tokens -----
  app.post<{ Body: { name?: string } }>('/sso/scim-tokens', async (req) => {
    const admin = requireAdmin(req);
    if (admin.via === 'token') fail(403, 'API tokens cannot create SCIM tokens');
    const token = `scim_${randomToken(32)}`;
    const r = await one(
      'insert into scim_tokens(workspace_id, name, token_hash, prefix, created_by) values ($1,$2,$3,$4,$5) returning id, name, prefix, created_at',
      [admin.workspaceId, req.body?.name || 'SCIM', sha256(token), token.slice(0, 10), admin.id],
    );
    await audit({ workspaceId: admin.workspaceId, actorId: admin.id, action: 'scim.token_created', targetType: 'scim_token', targetId: r.id, ip: req.ip });
    return { ...r, token };
  });
  app.delete<{ Params: { id: string } }>('/sso/scim-tokens/:id', async (req) => {
    const admin = requireAdmin(req);
    await q('update scim_tokens set revoked_at = now() where id = $1 and workspace_id = $2', [req.params.id, admin.workspaceId]);
    await audit({ workspaceId: admin.workspaceId, actorId: admin.id, action: 'scim.token_revoked', targetType: 'scim_token', targetId: req.params.id, ip: req.ip });
    return { ok: true };
  });

  // ----- Cognito sync -----
  app.post<{ Body: { dryRun?: boolean } }>('/sso/cognito-sync', async (req) => {
    const admin = requireAdmin(req);
    if (!s.cognito.userPoolId || !s.issuer) fail(400, 'COGNITO_USER_POOL_ID and SSO_ISSUER must be configured');
    await audit({ workspaceId: admin.workspaceId, actorId: admin.id, action: 'sso.sync_triggered', meta: { dryRun: !!req.body?.dryRun }, ip: req.ip });
    return runCognitoSync(awsCognitoApi(s.cognito.userPoolId!, s.cognito.region), { dryRun: req.body?.dryRun ?? s.cognito.dryRun });
  });

  if (s.cognito.userPoolId && s.issuer) {
    const api = awsCognitoApi(s.cognito.userPoolId, s.cognito.region);
    const tick = () => runAsLeader(async () => { await runCognitoSync(api); });
    const timer = setInterval(tick, Math.max(1, s.cognito.syncIntervalMinutes) * 60_000);
    const first = setTimeout(tick, 60_000); // first run a minute after boot
    app.addHook('onClose', async () => { clearInterval(timer); clearTimeout(first); });
  }
}
