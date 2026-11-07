import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { one, q } from '../db.js';
import type { Role } from '../auth.js';

export type ProviderKind = 'anthropic' | 'bedrock' | 'mock';
export type Feature = 'write' | 'chat' | 'autofill' | 'agents';

export interface AiSettings {
  enabled: boolean;
  provider: ProviderKind | null;
  bedrockRegion: string | null;
  models: { smart: string; fast: string };
  features: Record<Feature, boolean>;
  allowedRoles: Role[];
  monthlyBudgetUsd: number | null;
  perUserMonthlyBudgetUsd: number | null;
}

export const DEFAULT_MODELS = { smart: 'claude-opus-5-5', fast: 'claude-haiku-5-5' };

const DEFAULTS: AiSettings = {
  enabled: false,
  provider: null,
  bedrockRegion: null,
  models: DEFAULT_MODELS,
  features: { write: true, chat: true, autofill: true, agents: true },
  allowedRoles: ['owner', 'admin', 'member'], // guests are off by default
  monthlyBudgetUsd: null,
  perUserMonthlyBudgetUsd: null,
};

export const isProduction = () => process.env.NODE_ENV === 'production';

// ---------- encryption at rest (AES-256-GCM) ----------

function encryptionKey(): Buffer | null {
  const raw = config.ai.encryptionKey;
  if (!raw) return null;
  const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('Config: ATRIUM_ENCRYPTION_KEY must be 32 bytes (64 hex chars or base64)');
  return key;
}

export const encryptionAvailable = () => !!encryptionKey();

export function encrypt(plain: string): string {
  const key = encryptionKey();
  if (!key) throw new Error('ATRIUM_ENCRYPTION_KEY is not set');
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

export function decrypt(payload: string): string {
  const key = encryptionKey();
  if (!key) throw new Error('ATRIUM_ENCRYPTION_KEY is not set');
  const [v, iv, tag, data] = payload.split(':');
  if (v !== 'v1') throw new Error('Unknown key format');
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
}

// ---------- settings ----------

interface Row {
  settings: Partial<AiSettings>;
  api_key_enc: string | null;
  api_key_last4: string | null;
}

async function row(workspaceId: string): Promise<Row> {
  return (await one<Row>('select settings, api_key_enc, api_key_last4 from ai_settings where workspace_id = $1', [workspaceId])) ?? {
    settings: {},
    api_key_enc: null,
    api_key_last4: null,
  };
}

/** Stored settings merged with defaults and environment overrides (env wins). */
export async function getAiSettings(workspaceId: string): Promise<AiSettings & { keySource: 'env' | 'db' | null; apiKeyLast4: string | null }> {
  const r = await row(workspaceId);
  const s = { ...DEFAULTS, ...r.settings, models: { ...DEFAULT_MODELS, ...(r.settings.models ?? {}) }, features: { ...DEFAULTS.features, ...(r.settings.features ?? {}) } };
  if (config.ai.provider) s.provider = config.ai.provider;
  else if (!s.provider && config.ai.anthropicApiKey) s.provider = 'anthropic';
  if (config.ai.smartModel) s.models.smart = config.ai.smartModel;
  if (config.ai.fastModel) s.models.fast = config.ai.fastModel;
  if (s.provider === 'mock' && isProduction() && !config.ai.provider) s.provider = null; // DB-selected mock is dev-only
  const keySource = config.ai.anthropicApiKey ? 'env' : r.api_key_enc ? 'db' : null;
  const apiKeyLast4 = config.ai.anthropicApiKey ? config.ai.anthropicApiKey.slice(-4) : r.api_key_last4;
  return { ...s, keySource, apiKeyLast4 };
}

/** The usable first-party key (env first), or null. Never sent to clients. */
export async function getApiKey(workspaceId: string): Promise<string | null> {
  if (config.ai.anthropicApiKey) return config.ai.anthropicApiKey;
  const r = await row(workspaceId);
  if (!r.api_key_enc) return null;
  try {
    return decrypt(r.api_key_enc);
  } catch {
    return null; // key rotated / env missing: treat as not configured
  }
}

export async function saveAiSettings(workspaceId: string, patch: Partial<AiSettings>, apiKey?: string | null) {
  const r = await row(workspaceId);
  const next: Partial<AiSettings> = { ...r.settings };
  if (patch.enabled !== undefined) next.enabled = !!patch.enabled;
  if (patch.provider !== undefined) {
    if (patch.provider !== null && !['anthropic', 'bedrock', 'mock'].includes(patch.provider)) throw new Error('provider must be anthropic, bedrock or mock');
    if (patch.provider === 'mock' && isProduction()) throw new Error('The mock provider is only available outside production');
    next.provider = patch.provider;
  }
  if (patch.bedrockRegion !== undefined) next.bedrockRegion = patch.bedrockRegion || null;
  if (patch.models) next.models = { ...DEFAULT_MODELS, ...(r.settings.models ?? {}), ...Object.fromEntries(Object.entries(patch.models).filter(([, v]) => typeof v === 'string' && v.trim())) };
  if (patch.features) next.features = { ...DEFAULTS.features, ...(r.settings.features ?? {}), ...patch.features };
  if (patch.allowedRoles) next.allowedRoles = patch.allowedRoles.filter((x) => ['owner', 'admin', 'member', 'guest'].includes(x));
  if (patch.monthlyBudgetUsd !== undefined) next.monthlyBudgetUsd = patch.monthlyBudgetUsd == null ? null : Math.max(0, Number(patch.monthlyBudgetUsd));
  if (patch.perUserMonthlyBudgetUsd !== undefined) next.perUserMonthlyBudgetUsd = patch.perUserMonthlyBudgetUsd == null ? null : Math.max(0, Number(patch.perUserMonthlyBudgetUsd));

  let enc = r.api_key_enc;
  let last4 = r.api_key_last4;
  if (apiKey !== undefined) {
    if (apiKey === '' || apiKey === null) {
      enc = null;
      last4 = null;
    } else {
      if (!encryptionAvailable()) throw new Error('Set ATRIUM_ENCRYPTION_KEY on the server to store an API key, or provide ANTHROPIC_API_KEY as an environment variable instead.');
      enc = encrypt(apiKey.trim());
      last4 = apiKey.trim().slice(-4);
    }
  }
  await q(
    `insert into ai_settings(workspace_id, settings, api_key_enc, api_key_last4, updated_at) values ($1,$2,$3,$4, now())
     on conflict (workspace_id) do update set settings = excluded.settings, api_key_enc = excluded.api_key_enc,
       api_key_last4 = excluded.api_key_last4, updated_at = now()`,
    [workspaceId, next, enc, last4],
  );
}
