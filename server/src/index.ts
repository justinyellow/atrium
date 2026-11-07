import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import fstatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authenticate, HttpError, parseCookies, SESSION_COOKIE, userFromSessionToken } from './auth.js';
import { closeDb, migrate, q } from './db.js';
import { config } from './config.js';
import { closeRedis, redis, redisEnabled } from './redis.js';
import { storage } from './storage.js';
import { hocuspocus } from './collab.js';
import { addClient, closeEventClients, startEventBus } from './events.js';
import authRoutes from './routes/auth.js';
import pageRoutes from './routes/pages.js';
import databaseRoutes from './routes/databases.js';
import workspaceRoutes from './routes/workspace.js';
import miscRoutes from './routes/misc.js';
import sharingRoutes from './routes/sharing.js';
import dbViewRoutes from './routes/dbviews.js';
import blockRoutes from './routes/blocks.js';
import adminRoutes from './routes/admin.js';
import emailRoutes from './routes/email.js';
import ssoRoutes from './routes/sso.js';
import scimRoutes from './routes/scim.js';
import { openapi } from './openapi.js';
import mcpRoutes from './mcp.js';
import { oauthApiRoutes, oauthRoutes } from './oauth.js';
import { setToolApp } from './tools/context.js';
import aiRoutes from './routes/ai.js';
import importRoutes from './routes/import.js';
import { startAutofillJob, stopAutofillJob } from './ai/autofill.js';

const PORT = config.port;
// Fastify logs JSON lines to stdout (CloudWatch / docker logs friendly).
const app = Fastify({ logger: { level: config.logLevel }, bodyLimit: 20 * 1024 * 1024, trustProxy: true });

await migrate();
// Idempotent data fix: older rows stored non-ISO date strings (e.g. "2026-10-20 14:05:00Z").
import('./routes/databases.js')
  .then((m) => m.backfillIsoDates())
  .then((n) => n && console.log(JSON.stringify({ level: 'info', msg: 'normalised date values', rows: n })))
  .catch((e) => console.error(JSON.stringify({ level: 'error', msg: 'date backfill failed', err: e.message })));
startEventBus();
startAutofillJob();
let shuttingDown = false;
await app.register(cookie);
// Accept an empty body with content-type: application/json (common from API clients on DELETE/POST).
app.removeContentTypeParser('application/json');
app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
  const text = String(body ?? '');
  if (!text.trim()) return done(null, {});
  try {
    done(null, JSON.parse(text));
  } catch {
    const err: any = new Error('Invalid JSON body');
    err.statusCode = 400;
    done(err, undefined);
  }
});
await app.register(multipart, { limits: { fileSize: 100 * 1024 * 1024 } });
await app.register(websocket);

app.setErrorHandler((err: any, _req, reply) => {
  if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
  if (err.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ error: err.message });
  if (err.code === '22P02') return reply.status(404).send({ error: 'Not found' }); // invalid uuid
  app.log.error(err);
  console.error(err);
  return reply.status(500).send({ error: 'Internal error' });
});

await app.register(
  async (api) => {
    api.addHook('preHandler', async (req, reply) => {
      // CSRF: cookie-authenticated writes must come from our own origin.
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !req.headers.authorization) {
        const origin = req.headers.origin;
        const host = (req.headers['x-forwarded-host'] as string | undefined)?.split(',')[0].trim() ?? req.headers.host;
        if (origin && new URL(origin).host !== host) return reply.status(403).send({ error: 'Cross-origin request blocked' });
      }
      req.user = await authenticate(req);
    });
    // Liveness: the process is up. Readiness: dependencies reachable and not draining.
    api.get('/health', async () => ({ ok: true }));
    api.get('/ready', async (_req, reply) => {
      const checks: Record<string, string> = {};
      try { await q('select 1'); checks.db = 'ok'; } catch (e: any) { checks.db = e.message; }
      if (redisEnabled()) { try { await redis().ping(); checks.redis = 'ok'; } catch (e: any) { checks.redis = e.message; } }
      try { await storage.check(); checks.storage = 'ok'; } catch (e: any) { checks.storage = e.message; }
      const ok = !shuttingDown && Object.values(checks).every((v) => v === 'ok');
      return reply.status(ok ? 200 : 503).send({ ok, draining: shuttingDown, checks });
    });
    await api.register(authRoutes);
    await api.register(pageRoutes);
    await api.register(databaseRoutes);
    await api.register(dbViewRoutes);
    await api.register(workspaceRoutes);
    await api.register(miscRoutes);
    await api.register(sharingRoutes);
    await api.register(blockRoutes);
    await api.register(adminRoutes);
    await api.register(emailRoutes);
    await api.register(ssoRoutes);
    await api.register(aiRoutes);
    await api.register(importRoutes);
    await api.register(oauthApiRoutes);
    api.get('/openapi.json', async () => openapi);

    api.get('/events', { websocket: true }, async (socket, req) => {
      const user = await userFromSessionToken(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
      if (!user) return socket.close(4001, 'unauthorized');
      addClient(socket as any, user.id);
      socket.on('message', () => {}); // keepalive pings
    });
  },
  { prefix: '/api/v1' },
);

// Remote MCP server + OAuth 2.1 for connectors (stateless; any instance serves any request).
setToolApp(app);
await app.register(oauthRoutes);
await app.register(mcpRoutes);
// SCIM 2.0 provisioning (own bearer-token auth + SCIM error format).
await app.register(scimRoutes, { prefix: '/scim/v2' });

app.get('/collab', { websocket: true }, (socket, req) => {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
  const request = new Request(`http://localhost${req.url}`, { headers });
  const conn = hocuspocus.handleConnection(socket as any, request);
  socket.on('message', (data: Buffer) => conn.handleMessage(new Uint8Array(data)));
  socket.on('close', (code: number, reason: Buffer) => conn.handleClose({ code, reason: reason.toString() } as any));
  socket.on('pong', () => conn.touch());
});

// Serve the built web app in production.
const webDist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist');
if (existsSync(webDist)) {
  await app.register(fstatic, { root: webDist, wildcard: false });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.status(404).send({ error: 'Not found' });
    return reply.sendFile('index.html');
  });
}

// Graceful shutdown (ECS sends SIGTERM, then SIGKILL after stopTimeout): fail readiness, stop
// accepting, persist open documents, close sockets, Redis and Postgres.
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
  const hard = setTimeout(() => process.exit(1), config.shutdownGraceSeconds * 1000);
  hard.unref();
  try {
    hocuspocus.flushPendingStores();
    await new Promise((r) => setTimeout(r, 1000)); // let flushed stores reach Postgres
    hocuspocus.closeConnections();
    closeEventClients();
    stopAutofillJob();
    await app.close();
    await closeRedis();
    await closeDb();
  } catch (e: any) {
    app.log.error(e, 'error during shutdown');
  }
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

await app.listen({ port: PORT, host: '0.0.0.0' });
app.log.info({ port: PORT, storage: config.storage.driver, redis: redisEnabled(), publicUrl: config.publicUrl ?? null }, 'Atrium server listening');
console.log(`Atrium server listening on http://localhost:${PORT}`);
