/**
 * In-app AI API contract (shared with server/src/routes/ai*.ts). All paths are under /api/v1.
 *
 * GET  /ai/status                       → AiStatus (any member)
 * GET  /admin/ai/settings               → AiSettings (admins)
 * PUT  /admin/ai/settings               ← Partial<AiSettings> & { apiKey?: string }  (apiKey is write-only; '' clears it)
 * POST /admin/ai/test                   → { ok, model?, latencyMs?, error? }
 * GET  /admin/ai/usage?from=&to=        → AiUsage (admins)
 * POST /ai/write            (SSE)       ← AiWriteRequest   events: delta {text} · done {usage} · error {message, code}
 * POST /ai/chat             (SSE)       ← AiChatRequest    events: conversation {id,title} · delta {text} · tool_call · tool_result ·
 *                                                                 confirm · citations {pages} · done {usage} · error
 * POST /ai/chat/:id/confirm (SSE)       ← { toolCallId, approve }   (resumes an agent run paused on `confirm`)
 * GET  /ai/conversations                → AiConversationSummary[]
 * GET  /ai/conversations/:id            → AiConversation
 * DELETE /ai/conversations/:id
 * POST /databases/:id/ai-fill           ← { propId, rowIds?: string[], onlyEmpty?: boolean } → { queued } (runs async; db events refetch)
 *
 * Errors: 402 = budget exhausted, 403 = AI disabled for this user/feature. JSON body { error }.
 */

export type AiFeature = 'write' | 'chat' | 'autofill' | 'agents';
export type AiProvider = 'anthropic' | 'bedrock' | 'mock';

export interface AiStatus {
  enabled: boolean;
  provider: AiProvider | null;
  features: Record<AiFeature, boolean>;
  models: { smart: string; fast: string };
  budget: { usedUsd: number; limitUsd: number | null; userUsedUsd: number; userLimitUsd: number | null };
  reason?: string | null;
}

export interface AiSettings {
  enabled: boolean;
  provider: AiProvider;
  apiKey: { set: boolean; last4: string | null; source: 'env' | 'db' | null };
  bedrockRegion: string | null;
  models: { smart: string; fast: string };
  features: Record<AiFeature, boolean>;
  allowedRoles: ('owner' | 'admin' | 'member' | 'guest')[];
  monthlyBudgetUsd: number | null;
  perUserMonthlyBudgetUsd: number | null;
}

export interface AiUsage {
  from?: string;
  to?: string;
  totalUsd: number;
  requests: number;
  tokens: { input: number; output: number } | null;
  byFeature: { feature: AiFeature | string; usd: number; requests: number }[];
  byUser: { userId: string | null; name: string; usd: number; requests: number }[];
  byDay: { day: string; usd: number; requests?: number }[];
}

/** Actions accepted by POST /ai/write (server/src/ai/write.ts WRITE_ACTIONS). */
export type AiWriteAction = 'improve' | 'fix' | 'shorter' | 'longer' | 'tone' | 'translate' | 'summarize' | 'explain' | 'continue' | 'custom';
/** Client-side menu items that map onto a write action (see AskAi.start). */
export type AiMenuAction = AiWriteAction | 'outline' | 'brainstorm' | 'action_items' | 'summarize_page';

export interface AiWriteRequest {
  action: AiWriteAction;
  pageId: string;
  /** Text to transform (selection, or the page for whole-page actions). The server adds saved page context for continue/custom/explain. */
  text?: string;
  prompt?: string;
  tone?: string;
  language?: string;
}

export interface AiChatRequest {
  conversationId?: string | null;
  message: string;
  pageId?: string | null;
  mode: 'ask' | 'agent';
}

export interface AiToolCall { id: string; name: string; input?: unknown; summary: string }
export interface AiToolResult { id: string; ok: boolean; summary: string; pageId?: string | null }
export interface AiCitation { id: string; title: string; icon?: string | null }

export interface AiConversationSummary { id: string; title: string; mode: 'ask' | 'agent'; updated_at: string }
export interface AiStoredMessage {
  role: 'user' | 'assistant';
  content: string;
  citations?: AiCitation[];
  steps?: { call: AiToolCall; result?: AiToolResult }[];
}
export interface AiConversation extends AiConversationSummary { messages: AiStoredMessage[] }

export interface AiPropConfig {
  kind: 'summary' | 'keywords' | 'translate' | 'custom';
  instruction: string;
  language?: string;
  outputType: 'text' | 'select' | 'multi_select';
  autoUpdate: boolean;
}

export const DEFAULT_MODELS = { smart: 'claude-opus-5-5', fast: 'claude-haiku-5-5' };
