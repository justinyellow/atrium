import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { HttpError, requireAdmin, requireUser } from '../auth.js';
import { q } from '../db.js';
import { audit } from '../audit.js';
import { assertPage } from '../perms.js';
import { confirmChat, deleteConversation, getConversation, listConversations, startChat, type Emit } from '../ai/chat.js';
import { runWrite } from '../ai/write.js';
import { queueFill } from '../ai/autofill.js';
import { clearProviderCache, getProvider } from '../ai/provider.js';
import { encryptionAvailable, getAiSettings, isProduction, saveAiSettings } from '../ai/settings.js';
import { monthSpend, recordUsage } from '../ai/usage.js';

/**
 * Server-Sent Events: `event: <name>\ndata: <json>\n\n`. Pre-flight checks (auth, budget, validation)
 * run inside `fn` before the first event is written, so they still return normal JSON errors (e.g. 402).
 */
async function sse(req: FastifyRequest, reply: FastifyReply, fn: (emit: Emit, signal: AbortSignal) => Promise<void>) {
  const ac = new AbortController();
  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no', // nginx: don't buffer the stream
    });
    reply.raw.on('close', () => ac.abort());
  };
  const emit: Emit = (event, data) => {
    start();
    if (!reply.raw.writableEnded) reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  // Keep proxies (ALB / nginx idle timeouts) from closing long agent turns.
  const ping = setInterval(() => started && !reply.raw.writableEnded && reply.raw.write(': ping\n\n'), 15_000);
  try {
    await fn(emit, ac.signal);
  } catch (e: any) {
    if (!started) throw e; // still a normal JSON error response
    if (!ac.signal.aborted) {
      if (!(e instanceof HttpError)) console.error(JSON.stringify({ level: 'error', msg: 'ai stream failed', err: e?.message }));
      emit('error', { message: e instanceof HttpError ? e.message : 'Something went wrong while talking to the AI.' });
    }
  } finally {
    clearInterval(ping);
    if (started && !reply.raw.writableEnded) reply.raw.end();
  }
}

export default async function aiRoutes(app: FastifyInstance) {
  app.get('/ai/status', async (req) => {
    const user = requireUser(req);
    const s = await getAiSettings(user.workspaceId);
    const { orgUsedUsd, userUsedUsd } = await monthSpend(user.workspaceId, user.id);
    let reason: string | undefined;
    if (!s.enabled) reason = 'AI is turned off for this workspace.';
    else if (!s.provider) reason = 'No AI provider is configured.';
    else if (s.provider === 'anthropic' && !s.keySource) reason = 'No Anthropic API key is configured.';
    else if (!s.allowedRoles.includes(user.role)) reason = 'AI is not available for your role.';
    else if (s.monthlyBudgetUsd != null && orgUsedUsd >= s.monthlyBudgetUsd) reason = "The workspace's monthly AI budget is used up.";
    else if (s.perUserMonthlyBudgetUsd != null && userUsedUsd >= s.perUserMonthlyBudgetUsd) reason = 'Your monthly AI budget is used up.';
    return {
      enabled: !reason,
      provider: s.provider,
      features: { write: s.features.write, chat: s.features.chat, autofill: s.features.autofill, agents: s.features.agents },
      models: s.models,
      budget: { orgUsedUsd, orgLimitUsd: s.monthlyBudgetUsd, userUsedUsd, userLimitUsd: s.perUserMonthlyBudgetUsd },
      ...(reason ? { reason } : {}),
    };
  });

  // ----- admin -----
  const settingsOut = async (workspaceId: string) => {
    const s = await getAiSettings(workspaceId);
    return {
      enabled: s.enabled,
      provider: s.provider,
      apiKeySet: !!s.keySource,
      apiKeyLast4: s.apiKeyLast4,
      keySource: s.keySource,
      bedrockRegion: s.bedrockRegion,
      models: s.models,
      features: s.features,
      allowedRoles: s.allowedRoles,
      monthlyBudgetUsd: s.monthlyBudgetUsd,
      perUserMonthlyBudgetUsd: s.perUserMonthlyBudgetUsd,
      encryptionAvailable: encryptionAvailable(),
      mockAvailable: !isProduction(),
    };
  };

  app.get('/admin/ai/settings', async (req) => settingsOut(requireAdmin(req).workspaceId));

  app.put<{ Body: any }>('/admin/ai/settings', async (req) => {
    const admin = requireAdmin(req);
    const b: any = req.body ?? {};
    try {
      await saveAiSettings(admin.workspaceId, b, b.apiKey === undefined ? undefined : b.apiKey);
    } catch (e: any) {
      throw new HttpError(400, e.message);
    }
    clearProviderCache();
    const { apiKey, ...rest } = b;
    await audit({
      workspaceId: admin.workspaceId, actorId: admin.id, action: 'ai.settings_changed', ip: req.ip,
      meta: { ...rest, ...(apiKey !== undefined ? { apiKey: apiKey ? 'set' : 'cleared' } : {}) },
    });
    return settingsOut(admin.workspaceId);
  });

  app.post('/admin/ai/test', async (req) => {
    const admin = requireAdmin(req);
    const s = await getAiSettings(admin.workspaceId);
    const started = Date.now();
    try {
      const provider = await getProvider(admin.workspaceId, s);
      const res = await provider.run({ model: s.models.fast, system: 'Reply with the single word OK.', messages: [{ role: 'user', content: 'Connection test' }], effort: 'low', maxTokens: 1024 });
      await recordUsage({ workspaceId: admin.workspaceId, userId: admin.id, feature: 'test', model: res.model, usage: res.usage });
      return { ok: true, model: res.model, latencyMs: Date.now() - started };
    } catch (e: any) {
      return { ok: false, model: s.models.fast, latencyMs: Date.now() - started, error: e?.message ?? 'Connection failed' };
    }
  });

  app.get<{ Querystring: { from?: string; to?: string } }>('/admin/ai/usage', async (req) => {
    const admin = requireAdmin(req);
    const from = req.query.from ? new Date(req.query.from) : new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const to = req.query.to ? new Date(req.query.to) : new Date(Date.now() + 86400_000);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw new HttpError(400, 'from/to must be dates');
    const args = [admin.workspaceId, from.toISOString(), to.toISOString()];
    const where = `workspace_id = $1 and created_at >= $2 and created_at < $3`;
    const [total, byUser, byFeature, byDay] = await Promise.all([
      q(`select coalesce(sum(cost_usd),0)::float as usd from ai_usage where ${where}`, args),
      q(`select a.user_id as "userId", coalesce(u.name, 'Background jobs') as name, sum(a.cost_usd)::float as usd, count(*)::int as requests
         from ai_usage a left join users u on u.id = a.user_id where ${where.replace(/workspace_id|created_at/g, (m) => `a.${m}`)}
         group by a.user_id, u.name order by usd desc`, args),
      q(`select feature, sum(cost_usd)::float as usd, count(*)::int as requests from ai_usage where ${where} group by feature order by usd desc`, args),
      q(`select to_char(date_trunc('day', created_at), 'YYYY-MM-DD') as day, sum(cost_usd)::float as usd from ai_usage where ${where} group by 1 order by 1`, args),
    ]);
    return { totalUsd: total[0]?.usd ?? 0, byUser, byFeature, byDay };
  });

  // ----- write (Ask AI on a selection) -----
  app.post<{ Body: any }>('/ai/write', async (req, reply) => {
    const user = requireUser(req);
    await sse(req, reply, (emit, signal) => runWrite(user, (req.body ?? {}) as any, emit, signal));
  });

  // ----- chat / agent -----
  app.post<{ Body: any }>('/ai/chat', async (req, reply) => {
    const user = requireUser(req);
    const b: any = req.body ?? {};
    if (b.pageId) await assertPage(user, b.pageId, 'view');
    await sse(req, reply, (emit, signal) => startChat(user, b, emit, signal));
  });

  app.post<{ Params: { id: string }; Body: { toolCallId: string; approve: boolean } }>('/ai/chat/:id/confirm', async (req, reply) => {
    const user = requireUser(req);
    const b = req.body ?? ({} as any);
    if (!b.toolCallId) throw new HttpError(400, 'toolCallId is required');
    await sse(req, reply, (emit, signal) => confirmChat(user, req.params.id, b.toolCallId, !!b.approve, emit, signal));
  });

  app.get('/ai/conversations', async (req) => listConversations(requireUser(req)));
  app.get<{ Params: { id: string } }>('/ai/conversations/:id', async (req) => getConversation(requireUser(req), req.params.id));
  app.delete<{ Params: { id: string } }>('/ai/conversations/:id', async (req) => {
    await deleteConversation(requireUser(req), req.params.id);
    return { ok: true };
  });

  // ----- database AI autofill -----
  app.post<{ Params: { id: string }; Body: { propId: string; rowIds?: string[] } }>('/databases/:id/ai-fill', async (req) => {
    const user = requireUser(req);
    await assertPage(user, req.params.id, 'edit');
    const b = req.body ?? ({} as any);
    if (!b.propId) throw new HttpError(400, 'propId is required');
    const queued = await queueFill(user, user.workspaceId, req.params.id, b.propId, b.rowIds);
    return { queued };
  });
}
