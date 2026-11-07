import type { FastifyInstance, FastifyReply } from 'fastify';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { fail, randomToken, requireUser, sha256 } from './auth.js';
import { one, q } from './db.js';
import { baseUrl } from './mcp.js';
import { audit } from './audit.js';

/**
 * OAuth 2.1 authorization server for MCP connectors (Claude.ai, Claude Desktop, ...).
 * Authorization code + PKCE (S256 only), dynamic client registration, refresh-token rotation, revocation.
 * All state lives in Postgres so any instance can serve any step.
 */
const ACCESS_TTL_S = 3600;
const REFRESH_TTL_DAYS = 30;
const CODE_TTL_S = 300;
export const SCOPE = 'mcp';

const b64url = (b: Buffer) => b.toString('base64url');
const pkceS256 = (verifier: string) => b64url(createHash('sha256').update(verifier).digest());
const safeEq = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

function validRedirect(uri: string) {
  try {
    const u = new URL(uri);
    if (u.hash) return false;
    if (u.protocol === 'https:') return true;
    // Loopback redirects for native/desktop clients (RFC 8252).
    return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
}

function oauthError(reply: FastifyReply, status: number, error: string, description: string) {
  return reply.status(status).header('Cache-Control', 'no-store').send({ error, error_description: description });
}

async function issueTokens(clientId: string, userId: string, scope: string) {
  const access = `ato_${randomToken(32)}`;
  const refresh = `atrr_${randomToken(32)}`;
  await q(
    `insert into oauth_tokens(client_id, user_id, access_hash, refresh_hash, scope, access_expires_at, refresh_expires_at)
     values ($1,$2,$3,$4,$5, now() + ($6 || ' seconds')::interval, now() + ($7 || ' days')::interval)`,
    [clientId, userId, sha256(access), sha256(refresh), scope, String(ACCESS_TTL_S), String(REFRESH_TTL_DAYS)],
  );
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_S, refresh_token: refresh, scope };
}

async function authenticateClient(body: any, authHeader?: string) {
  let clientId = body.client_id;
  let secret = body.client_secret;
  if (authHeader?.startsWith('Basic ')) {
    const [id, s] = Buffer.from(authHeader.slice(6), 'base64').toString().split(':');
    clientId = decodeURIComponent(id);
    secret = decodeURIComponent(s ?? '');
  }
  const client = clientId ? await one('select * from oauth_clients where client_id = $1', [clientId]) : undefined;
  if (!client) return null;
  if (client.client_secret_hash && !(secret && safeEq(sha256(secret), client.client_secret_hash))) return null;
  return client;
}

/** Public OAuth endpoints (root level, no session). */
export async function oauthRoutes(app: FastifyInstance) {
  // RFC 6749 token/revoke requests are form-encoded.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });

  const resourceMetadata = async (req: any) => {
    const base = baseUrl(req);
    return {
      resource: `${base}/mcp`,
      authorization_servers: [base],
      scopes_supported: [SCOPE],
      bearer_methods_supported: ['header'],
      resource_name: 'Atrium',
    };
  };
  app.get('/.well-known/oauth-protected-resource', resourceMetadata);
  app.get('/.well-known/oauth-protected-resource/mcp', resourceMetadata);

  const asMetadata = async (req: any) => {
    const base = baseUrl(req);
    return {
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      revocation_endpoint: `${base}/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      scopes_supported: [SCOPE],
    };
  };
  app.get('/.well-known/oauth-authorization-server', asMetadata);
  app.get('/.well-known/oauth-authorization-server/mcp', asMetadata);

  // RFC 7591 dynamic client registration.
  app.post<{ Body: any }>('/oauth/register', async (req, reply) => {
    const b: any = req.body ?? {};
    const uris: string[] = Array.isArray(b.redirect_uris) ? b.redirect_uris : [];
    if (!uris.length || !uris.every(validRedirect))
      return oauthError(reply, 400, 'invalid_redirect_uri', 'redirect_uris must be https URLs (or http loopback)');
    const method = b.token_endpoint_auth_method ?? 'none';
    if (!['none', 'client_secret_post', 'client_secret_basic'].includes(method))
      return oauthError(reply, 400, 'invalid_client_metadata', 'Unsupported token_endpoint_auth_method');
    const name = String(b.client_name ?? 'MCP client').slice(0, 100);
    const clientId = `atc_${randomToken(16)}`;
    const secret = method === 'none' ? null : randomToken(32);
    await q('insert into oauth_clients(client_id, client_secret_hash, name, redirect_uris) values ($1,$2,$3,$4)', [
      clientId, secret ? sha256(secret) : null, name, JSON.stringify(uris),
    ]);
    return reply.status(201).header('Cache-Control', 'no-store').send({
      client_id: clientId,
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: name,
      redirect_uris: uris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: method,
      scope: SCOPE,
    });
  });

  // Validates the request, then hands over to the web consent page (which requires a logged-in user).
  app.get<{ Querystring: Record<string, string> }>('/oauth/authorize', async (req, reply) => {
    const p = req.query;
    const client = p.client_id ? await one('select * from oauth_clients where client_id = $1', [p.client_id]) : undefined;
    if (!client) return reply.status(400).type('text/plain').send('Unknown OAuth client. Remove and re-add the connector.');
    if (!p.redirect_uri || !client.redirect_uris.includes(p.redirect_uri)) return reply.status(400).type('text/plain').send('redirect_uri is not registered for this client.');
    const back = (error: string, desc: string) => {
      const u = new URL(p.redirect_uri);
      u.searchParams.set('error', error);
      u.searchParams.set('error_description', desc);
      if (p.state) u.searchParams.set('state', p.state);
      return reply.redirect(u.toString());
    };
    if (p.response_type !== 'code') return back('unsupported_response_type', 'Only response_type=code is supported');
    if (!p.code_challenge || p.code_challenge_method !== 'S256') return back('invalid_request', 'PKCE with S256 is required');
    const params = new URLSearchParams();
    for (const k of ['client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'state', 'scope', 'resource']) if (p[k]) params.set(k, p[k]);
    return reply.redirect(`/oauth/consent?${params}`);
  });

  app.post<{ Body: any }>('/oauth/token', async (req, reply) => {
    const b: any = req.body ?? {};
    const client = await authenticateClient(b, req.headers.authorization);
    if (!client) return oauthError(reply, 401, 'invalid_client', 'Client authentication failed');
    reply.header('Cache-Control', 'no-store').header('Pragma', 'no-cache');

    if (b.grant_type === 'authorization_code') {
      const row = b.code ? await one('select * from oauth_codes where code_hash = $1', [sha256(String(b.code))]) : undefined;
      if (!row || row.client_id !== client.client_id || new Date(row.expires_at) < new Date())
        return oauthError(reply, 400, 'invalid_grant', 'Authorization code is invalid or expired');
      if (row.used_at) {
        // Code replay: revoke anything issued to this client for this user.
        await q('update oauth_tokens set revoked_at = now() where client_id = $1 and user_id = $2 and revoked_at is null', [row.client_id, row.user_id]);
        return oauthError(reply, 400, 'invalid_grant', 'Authorization code was already used');
      }
      if (b.redirect_uri !== row.redirect_uri) return oauthError(reply, 400, 'invalid_grant', 'redirect_uri mismatch');
      if (!b.code_verifier || !safeEq(pkceS256(String(b.code_verifier)), row.code_challenge))
        return oauthError(reply, 400, 'invalid_grant', 'PKCE verification failed');
      const claimed = await one('update oauth_codes set used_at = now() where code_hash = $1 and used_at is null returning 1 as ok', [row.code_hash]);
      if (!claimed) return oauthError(reply, 400, 'invalid_grant', 'Authorization code was already used');
      return issueTokens(client.client_id, row.user_id, row.scope);
    }

    if (b.grant_type === 'refresh_token') {
      const row = b.refresh_token ? await one('select * from oauth_tokens where refresh_hash = $1', [sha256(String(b.refresh_token))]) : undefined;
      if (!row || row.client_id !== client.client_id) return oauthError(reply, 400, 'invalid_grant', 'Refresh token is invalid');
      if (row.revoked_at) {
        // Rotated token presented again: treat as theft and revoke the whole grant.
        await q('update oauth_tokens set revoked_at = now() where client_id = $1 and user_id = $2 and revoked_at is null', [row.client_id, row.user_id]);
        return oauthError(reply, 400, 'invalid_grant', 'Refresh token was already used');
      }
      if (new Date(row.refresh_expires_at) < new Date()) return oauthError(reply, 400, 'invalid_grant', 'Refresh token expired');
      const user = await one('select active from users where id = $1', [row.user_id]);
      if (!user?.active) return oauthError(reply, 400, 'invalid_grant', 'User is deactivated');
      const rotated = await one('update oauth_tokens set revoked_at = now() where id = $1 and revoked_at is null returning 1 as ok', [row.id]);
      if (!rotated) return oauthError(reply, 400, 'invalid_grant', 'Refresh token was already used');
      return issueTokens(client.client_id, row.user_id, row.scope);
    }

    return oauthError(reply, 400, 'unsupported_grant_type', 'Use authorization_code or refresh_token');
  });

  // RFC 7009: always 200, even for unknown tokens.
  app.post<{ Body: any }>('/oauth/revoke', async (req, reply) => {
    const b: any = req.body ?? {};
    const client = await authenticateClient(b, req.headers.authorization);
    if (!client) return oauthError(reply, 401, 'invalid_client', 'Client authentication failed');
    if (b.token) {
      const h = sha256(String(b.token));
      await q('update oauth_tokens set revoked_at = now() where client_id = $1 and (access_hash = $2 or refresh_hash = $2) and revoked_at is null', [client.client_id, h]);
    }
    return reply.status(200).send({});
  });
}

/** Session-authenticated endpoints used by the consent page and Settings (registered under /api/v1). */
export async function oauthApiRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>('/oauth/clients/:id', async (req) => {
    requireUser(req);
    const c = await one('select client_id, name, redirect_uris, created_at from oauth_clients where client_id = $1', [req.params.id]);
    if (!c) fail(404, 'Unknown OAuth client');
    return c;
  });

  app.post<{ Body: any }>('/oauth/approve', async (req) => {
    const user = requireUser(req);
    if (user.via !== 'session') fail(403, 'Approve from the browser');
    const b: any = req.body ?? {};
    const client = await one('select * from oauth_clients where client_id = $1', [b.client_id]);
    if (!client) fail(400, 'Unknown OAuth client');
    if (!b.redirect_uri || !client.redirect_uris.includes(b.redirect_uri)) fail(400, 'redirect_uri is not registered for this client');
    const u = new URL(b.redirect_uri);
    if (b.state) u.searchParams.set('state', b.state);
    if (!b.approve) {
      u.searchParams.set('error', 'access_denied');
      u.searchParams.set('error_description', 'The user denied access');
      return { redirect: u.toString() };
    }
    if (!b.code_challenge || b.code_challenge_method !== 'S256') fail(400, 'PKCE with S256 is required');
    const code = randomBytes(32).toString('base64url');
    await q(
      `insert into oauth_codes(code_hash, client_id, user_id, redirect_uri, code_challenge, scope, resource, expires_at)
       values ($1,$2,$3,$4,$5,$6,$7, now() + ($8 || ' seconds')::interval)`,
      [sha256(code), client.client_id, user.id, b.redirect_uri, b.code_challenge, SCOPE, b.resource ?? null, String(CODE_TTL_S)],
    );
    await audit({ workspaceId: user.workspaceId, actorId: user.id, action: 'oauth.app_authorized', targetType: 'oauth_client', targetId: client.client_id, meta: { client_name: client.name, redirect_uri: b.redirect_uri }, ip: req.ip });
    u.searchParams.set('code', code);
    return { redirect: u.toString() };
  });

  app.get('/oauth/connections', async (req) => {
    const user = requireUser(req);
    return q(
      `select c.client_id, c.name, min(t.created_at) as connected_at, max(coalesce(t.last_used_at, t.created_at)) as last_used_at
       from oauth_tokens t join oauth_clients c on c.client_id = t.client_id
       where t.user_id = $1 and t.revoked_at is null and coalesce(t.refresh_expires_at, t.access_expires_at) > now()
       group by c.client_id, c.name order by last_used_at desc`,
      [user.id],
    );
  });

  app.delete<{ Params: { id: string } }>('/oauth/connections/:id', async (req) => {
    const user = requireUser(req);
    const r = await q('update oauth_tokens set revoked_at = now() where user_id = $1 and client_id = $2 and revoked_at is null returning 1', [user.id, req.params.id]);
    if (r.length) await audit({ workspaceId: user.workspaceId, actorId: user.id, action: 'oauth.app_disconnected', targetType: 'oauth_client', targetId: req.params.id, ip: req.ip });
    return { ok: true };
  });
}
