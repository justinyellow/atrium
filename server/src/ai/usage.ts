import { one, q } from '../db.js';
import { HttpError } from '../auth.js';
import type { AiSettings } from './settings.js';

/** USD per 1M tokens (first-party list prices; Bedrock is billed by AWS and may differ — estimates only). */
const PRICING: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
};

export interface TokenUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

export function costUsd(model: string, u: TokenUsage) {
  const p = PRICING[model.replace(/^anthropic\./, '')] ?? PRICING['claude-opus-5-5'];
  return (
    ((u.input_tokens ?? 0) * p.input + (u.output_tokens ?? 0) * p.output + (u.cache_read_input_tokens ?? 0) * p.cacheRead + (u.cache_creation_input_tokens ?? 0) * p.cacheWrite) /
    1_000_000
  );
}

export async function recordUsage(e: { workspaceId: string; userId: string | null; feature: string; model: string; usage: TokenUsage }) {
  const u = e.usage;
  await q(
    `insert into ai_usage(workspace_id, user_id, feature, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [e.workspaceId, e.userId, e.feature, e.model, u.input_tokens ?? 0, u.output_tokens ?? 0, u.cache_read_input_tokens ?? 0, u.cache_creation_input_tokens ?? 0, costUsd(e.model, u)],
  ).catch((err) => console.error(JSON.stringify({ level: 'error', msg: 'ai usage write failed', err: err.message })));
}

export async function monthSpend(workspaceId: string, userId?: string | null) {
  const org = await one<{ usd: string }>(`select coalesce(sum(cost_usd),0) as usd from ai_usage where workspace_id = $1 and created_at >= date_trunc('month', now())`, [workspaceId]);
  const user = userId
    ? await one<{ usd: string }>(`select coalesce(sum(cost_usd),0) as usd from ai_usage where user_id = $1 and created_at >= date_trunc('month', now())`, [userId])
    : undefined;
  return { orgUsedUsd: Number(org?.usd ?? 0), userUsedUsd: Number(user?.usd ?? 0) };
}

/** Throws 402 when this month's org or per-user budget is used up. */
export async function assertBudget(s: AiSettings, workspaceId: string, userId: string | null) {
  const { orgUsedUsd, userUsedUsd } = await monthSpend(workspaceId, userId);
  if (s.monthlyBudgetUsd != null && orgUsedUsd >= s.monthlyBudgetUsd) {
    throw new HttpError(402, `Your workspace has used its AI budget for this month ($${s.monthlyBudgetUsd.toFixed(2)}). Ask an admin to raise it.`);
  }
  if (userId && s.perUserMonthlyBudgetUsd != null && userUsedUsd >= s.perUserMonthlyBudgetUsd) {
    throw new HttpError(402, `You've used your personal AI budget for this month ($${s.perUserMonthlyBudgetUsd.toFixed(2)}).`);
  }
}
