import Anthropic, { betaRefusalFallbackMiddleware } from '@anthropic-ai/sdk';
import { AnthropicBedrockMantle } from '@anthropic-ai/bedrock-sdk';
import { HttpError } from '../auth.js';
import { getAiSettings, getApiKey, type AiSettings, type ProviderKind } from './settings.js';
import type { TokenUsage } from './usage.js';

type MessageParam = Anthropic.Beta.BetaMessageParam;
type Tool = Anthropic.Beta.BetaTool;
type ContentBlock = Anthropic.Beta.BetaContentBlock;

export interface ModelRun {
  /** First-party model id (e.g. claude-opus-5-5); mapped per provider. */
  model: string;
  system: string;
  messages: MessageParam[];
  tools?: Tool[];
  effort: 'low' | 'medium' | 'high';
  maxTokens: number;
  /** Final turn after hitting the tool-step cap: tools stay declared (cache/prefix) but can't be called. */
  noToolCalls?: boolean;
  onText?: (text: string) => void;
  signal?: AbortSignal;
}

export interface ModelResult {
  content: ContentBlock[];
  stop_reason: string | null;
  usage: TokenUsage;
  /** The model that actually served the response (differs after a refusal fallback). */
  model: string;
}

export interface Provider {
  kind: ProviderKind;
  run(r: ModelRun): Promise<ModelResult>;
}

/** Models that support the server-side `fallbacks: "default"` refusal fallback on the first-party API. */
const SERVER_FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5-5']);

/**
 * After a mid-output refusal fallback, blocks before the last `fallback` boundary that the next model can't
 * use (thinking / tool_use / unpaired server tool use) must not be echoed back. Everything else is kept verbatim.
 */
export function sanitizeForHistory(content: ContentBlock[]): ContentBlock[] {
  const last = content.map((b) => b.type).lastIndexOf('fallback' as any);
  if (last < 0) return content;
  return content.filter((b, i) => i >= last || !['thinking', 'redacted_thinking', 'tool_use', 'server_tool_use'].includes(b.type));
}

/** Sum per-attempt usage when a fallback ran (top-level usage only covers the final attempt). */
function totalUsage(msg: Anthropic.Beta.BetaMessage): TokenUsage {
  const it = (msg.usage as any).iterations as any[] | undefined;
  if (!it?.length) return msg.usage;
  return it.reduce(
    (a, x) => ({
      input_tokens: (a.input_tokens ?? 0) + (x.input_tokens ?? 0),
      output_tokens: (a.output_tokens ?? 0) + (x.output_tokens ?? 0),
      cache_read_input_tokens: (a.cache_read_input_tokens ?? 0) + (x.cache_read_input_tokens ?? 0),
      cache_creation_input_tokens: (a.cache_creation_input_tokens ?? 0) + (x.cache_creation_input_tokens ?? 0),
    }),
    {} as TokenUsage,
  );
}

function mapApiError(e: unknown): never {
  if (e instanceof Anthropic.AuthenticationError) throw new HttpError(502, 'The AI provider rejected the API key. An admin can update it in Settings → AI.');
  if (e instanceof Anthropic.PermissionDeniedError) throw new HttpError(502, 'The AI provider denied access to this model. Check the model settings.');
  if (e instanceof Anthropic.NotFoundError) throw new HttpError(502, 'The configured AI model was not found. Check the model settings.');
  if (e instanceof Anthropic.RateLimitError) throw new HttpError(429, 'The AI provider is rate limiting requests. Try again shortly.');
  if (e instanceof Anthropic.BadRequestError) throw new HttpError(502, `The AI request was rejected: ${e.message}`);
  if (e instanceof Anthropic.APIError) throw new HttpError(502, `The AI provider returned an error (${e.status ?? 'network'}).`);
  throw e;
}

class SdkProvider implements Provider {
  constructor(
    public kind: 'anthropic' | 'bedrock',
    private client: Anthropic | AnthropicBedrockMantle,
  ) {}

  async run(r: ModelRun): Promise<ModelResult> {
    const firstParty = this.kind === 'anthropic';
    const model = firstParty ? r.model : `anthropic.${r.model.replace(/^anthropic\./, '')}`;
    const params: any = {
      model,
      max_tokens: r.maxTokens,
      // Stable, frozen system prompt first so it caches; per-request context goes in the user turn.
      system: [{ type: 'text', text: r.system, cache_control: { type: 'ephemeral' } }],
      messages: r.messages,
      thinking: { type: 'adaptive' },
      output_config: { effort: r.effort },
    };
    if (r.tools?.length) params.tools = r.tools;
    if (r.noToolCalls) params.tool_choice = { type: 'none' };
    if (firstParty) {
      params.cache_control = { type: 'ephemeral' }; // auto-cache the growing conversation prefix
      if (SERVER_FALLBACK_MODELS.has(r.model)) {
        params.fallbacks = 'default';
        params.betas = ['server-side-fallback-2026-07-01'];
      }
    }
    try {
      const stream = (this.client as Anthropic).beta.messages.stream(params, { signal: r.signal });
      if (r.onText) stream.on('text', (t: string) => r.onText!(t));
      const msg = await stream.finalMessage();
      return { content: msg.content, stop_reason: msg.stop_reason, usage: totalUsage(msg), model: String(msg.model ?? model) };
    } catch (e) {
      if ((e as any)?.name === 'AbortError' || r.signal?.aborted) throw e;
      mapApiError(e);
    }
  }
}

// ---------- mock provider (deterministic, no network) ----------

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
let mockSeq = 0;

function textOf(m: MessageParam): string {
  if (typeof m.content === 'string') return m.content;
  return (m.content ?? []).map((b: any) => (b.type === 'text' ? b.text : b.type === 'tool_result' ? `[tool_result ${b.is_error ? 'error' : 'ok'}]` : '')).join('\n');
}

/**
 * Behaves like a small, predictable model so the whole AI stack is testable without a key:
 * - agent mode: "create a page …" → create-pages tool call; "delete … <uuid>" → delete-page tool call; then "Done."
 * - ask mode: answers from the <workspace_context> titles it was given.
 * - write: echoes a transformed version of the selected text.
 */
class MockProvider implements Provider {
  kind = 'mock' as const;
  async run(r: ModelRun): Promise<ModelResult> {
    const last = r.messages[r.messages.length - 1];
    const lastText = textOf(last);
    const inTurnToolResult = typeof last.content !== 'string' && (last.content ?? []).some((b: any) => b.type === 'tool_result');
    const toolNames = new Set((r.tools ?? []).map((t) => t.name));
    let content: ContentBlock[];
    let stop: string = 'end_turn';
    const userAsk = [...r.messages].reverse().find((m) => m.role === 'user' && typeof m.content !== 'string' ? !(m.content as any[]).some((b) => b.type === 'tool_result') : m.role === 'user');
    const ask = userAsk ? textOf(userAsk) : lastText;
    const question = (ask.split('</workspace_context>').pop() ?? ask).trim();

    if (!inTurnToolResult && !r.noToolCalls && toolNames.has('create-pages') && /create (a )?page/i.test(question)) {
      const title = question.match(/called\s+"([^"]+)"/i)?.[1] ?? 'AI created page';
      content = [{ type: 'text', text: 'Creating the page now.', citations: null } as any, { type: 'tool_use', id: `toolu_mock_${++mockSeq}`, name: 'create-pages', input: { pages: [{ title, content: 'Created by the Atrium AI agent.' }] } } as any];
      stop = 'tool_use';
    } else if (!inTurnToolResult && !r.noToolCalls && toolNames.has('delete-page') && /\bdelete\b/i.test(question) && UUID_RE.test(question)) {
      content = [{ type: 'tool_use', id: `toolu_mock_${++mockSeq}`, name: 'delete-page', input: { page_id: question.match(UUID_RE)![0] } } as any];
      stop = 'tool_use';
    } else if (inTurnToolResult) {
      content = [{ type: 'text', text: /error/.test(lastText) ? 'I could not complete that step.' : 'Done.', citations: null } as any];
    } else if (/<workspace_context>/.test(ask)) {
      const titles = [...ask.matchAll(/<page id="[^"]+" title="([^"]*)"/g)].map((m) => m[1]);
      content = [{ type: 'text', text: titles.length ? `Based on ${titles.length} page(s) — ${titles.join(', ')} — here is what I found about: ${question}` : `I couldn't find anything in the workspace about: ${question}`, citations: null } as any];
    } else {
      const sel = lastText.match(/<selection>([\s\S]*?)<\/selection>/)?.[1]?.trim() ?? lastText.slice(0, 200);
      const action = lastText.match(/<action>(\w+)<\/action>/)?.[1] ?? 'answer';
      content = [{ type: 'text', text: action === 'answer' ? `Mock answer to: ${lastText.slice(0, 120)}` : `${sel} (${action})`, citations: null } as any];
    }
    for (const b of content) if (b.type === 'text' && r.onText) for (const chunk of (b as any).text.match(/.{1,12}/gs) ?? []) r.onText(chunk);
    const inChars = r.system.length + r.messages.reduce((n, m) => n + textOf(m).length, 0);
    const outChars = JSON.stringify(content).length;
    return { content, stop_reason: stop, usage: { input_tokens: Math.ceil(inChars / 4), output_tokens: Math.ceil(outChars / 4), cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, model: r.model };
  }
}

// ---------- factory ----------

const clientCache = new Map<string, Provider>();

export async function getProvider(workspaceId: string, s?: AiSettings): Promise<Provider> {
  const settings = s ?? (await getAiSettings(workspaceId));
  if (!settings.provider) throw new HttpError(503, 'AI is not configured. An admin can set it up in Settings → AI.');
  if (settings.provider === 'mock') return new MockProvider();
  if (settings.provider === 'bedrock') {
    const region = settings.bedrockRegion ?? undefined;
    const key = `bedrock:${region}`;
    if (!clientCache.has(key)) {
      // Bedrock has no server-side `fallbacks`; the SDK middleware retries refusals on another model instead.
      const client = new AnthropicBedrockMantle({ awsRegion: region, middleware: [betaRefusalFallbackMiddleware([{ model: 'anthropic.claude-opus-4-8' }])] } as any);
      clientCache.set(key, new SdkProvider('bedrock', client));
    }
    return clientCache.get(key)!;
  }
  const apiKey = await getApiKey(workspaceId);
  if (!apiKey) throw new HttpError(503, 'No Anthropic API key is configured. An admin can add one in Settings → AI.');
  const key = `anthropic:${apiKey.slice(-8)}`;
  if (!clientCache.has(key)) clientCache.set(key, new SdkProvider('anthropic', new Anthropic({ apiKey })));
  return clientCache.get(key)!;
}

export function clearProviderCache() {
  clientCache.clear();
}
