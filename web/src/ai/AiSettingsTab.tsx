import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, AlertCircle, Loader2, Sparkles } from 'lucide-react';
import { get, post, put, queryClient } from '../lib/api';
import { useMe } from '../lib/hooks';
import { Toggle, toast } from '../components/ui';
import type { AiFeature, AiSettings, AiUsage } from './contract';
import { DEFAULT_MODELS } from './contract';
import { useAiStatus } from './sse';
import './ai.css';

const FEATURES: { id: AiFeature; label: string; hint: string }[] = [
  { id: 'write', label: 'Writing in pages', hint: 'Ask AI on selections, Space on an empty line, /ai' },
  { id: 'chat', label: 'Chat & workspace Q&A', hint: 'The Atrium AI panel (Ctrl+J), answers cite pages' },
  { id: 'agents', label: 'Agents', hint: 'Lets AI create and edit pages; asks before deleting' },
  { id: 'autofill', label: 'Database autofill', hint: 'AI properties that fill themselves in' },
];
const ROLES = ['owner', 'admin', 'member', 'guest'] as const;
const usd = (n: number | null | undefined) => `$${(n ?? 0).toFixed((n ?? 0) < 10 ? 2 : 0)}`;

/** Accept both `apiKey: {set,last4,source}` and the flat `keySource` / `apiKeyLast4` shape. */
function normalize(d: any): AiSettings {
  const apiKey = d.apiKey && typeof d.apiKey === 'object'
    ? d.apiKey
    : { set: d.apiKeySet ?? !!d.keySource, last4: d.apiKeyLast4 ?? null, source: d.keySource ?? null };
  return { ...d, apiKey, models: d.models ?? { ...DEFAULT_MODELS }, features: d.features ?? {}, allowedRoles: d.allowedRoles ?? [] };
}

/** Server usage may omit request / token totals; derive what we can. */
function normalizeUsage(d: any): AiUsage {
  const byUser = d.byUser ?? [];
  return {
    ...d,
    byDay: d.byDay ?? [],
    byFeature: d.byFeature ?? [],
    byUser,
    requests: d.requests ?? byUser.reduce((n: number, u: any) => n + (u.requests ?? 0), 0),
    tokens: d.tokens ?? null,
  };
}
const FEATURE_LABEL: Record<string, string> = { write: 'Writing in pages', chat: 'Chat & Q&A', agent: 'Agents', agents: 'Agents', autofill: 'Database autofill', test: 'Connection tests' };

function Bars({ rows }: { rows: { label: string; value: number; sub?: string }[] }) {
  const max = Math.max(...rows.map((r) => r.value), 0.0001);
  if (!rows.length) return <div className="faint" style={{ fontSize: 13, marginBottom: 18 }}>No usage yet.</div>;
  return (
    <div className="ai-bars">
      {rows.map((r) => (
        <div key={r.label} className="ai-bar-row" title={`${r.label}: ${usd(r.value)}${r.sub ? ` · ${r.sub}` : ''}`}>
          <span className="n">{r.label}</span>
          <span><div className="ai-bar" style={{ width: `${(r.value / max) * 100}%` }} /></span>
          <span className="val">{usd(r.value)}</span>
        </div>
      ))}
    </div>
  );
}

function Usage() {
  const q = useQuery({ queryKey: ['ai-usage'], queryFn: () => get('/admin/ai/usage').then(normalizeUsage) });
  const u = q.data;
  if (q.isLoading) return <div className="spinner" />;
  if (!u) return <div className="faint" style={{ fontSize: 13 }}>Usage isn’t available.</div>;
  const maxDay = Math.max(...u.byDay.map((d) => d.usd), 0.0001);
  return (
    <>
      <div className="ai-kpis">
        <div className="ai-kpi"><div className="v">{usd(u.totalUsd)}</div><div className="l">Spend this period</div></div>
        <div className="ai-kpi"><div className="v">{u.requests.toLocaleString()}</div><div className="l">Requests</div></div>
        {u.tokens ? (
          <div className="ai-kpi"><div className="v">{((u.tokens.input + u.tokens.output) / 1000).toFixed(0)}k</div><div className="l">Tokens ({(u.tokens.input / 1000).toFixed(0)}k in · {(u.tokens.output / 1000).toFixed(0)}k out)</div></div>
        ) : (
          <div className="ai-kpi"><div className="v">{u.byUser.filter((x) => x.userId).length}</div><div className="l">People using AI</div></div>
        )}
      </div>
      {!!u.byDay.length && (
        <>
          <h3 className="set-h3">Spend by day</h3>
          <div className="ai-days" role="img" aria-label="Daily AI spend">
            {u.byDay.map((d) => (
              <div key={d.day} className="ai-day-hit" title={`${d.day}: ${usd(d.usd)}${d.requests != null ? ` · ${d.requests} requests` : ''}`}>
                <div className="ai-day" style={{ height: `${Math.max((d.usd / maxDay) * 100, 2)}%`, width: '100%' }} />
              </div>
            ))}
          </div>
          <div className="ai-days-axis"><span>{u.byDay[0].day}</span><span>{u.byDay[u.byDay.length - 1].day}</span></div>
        </>
      )}
      <h3 className="set-h3">By feature</h3>
      <Bars rows={u.byFeature.map((f) => ({ label: FEATURE_LABEL[String(f.feature)] ?? String(f.feature), value: f.usd, sub: `${f.requests} requests` }))} />
      <h3 className="set-h3">By person</h3>
      <Bars rows={u.byUser.slice(0, 12).map((x) => ({ label: x.name, value: x.usd, sub: `${x.requests} requests` }))} />
    </>
  );
}

export function AiSettingsTab() {
  const { data: me } = useMe();
  const admin = me?.role === 'owner' || me?.role === 'admin';
  const { data: status } = useAiStatus();
  const q = useQuery({ queryKey: ['ai-settings'], queryFn: () => get('/admin/ai/settings').then(normalize), enabled: admin, retry: false });
  const [f, setF] = useState<AiSettings | null>(null);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  useEffect(() => { if (q.data) setF(q.data); }, [q.data]);

  if (!admin) {
    return (
      <div>
        <h2>AI</h2>
        {!status ? <div className="muted">Atrium AI isn’t available on this server.</div> : (
          <>
            <div className="muted" style={{ fontSize: 13, marginBottom: 12 }}>Workspace admins manage the AI provider and budgets.</div>
            <div className="ai-kpis" style={{ gridTemplateColumns: 'repeat(2, minmax(0,1fr))' }}>
              <div className="ai-kpi"><div className="v">{status.enabled ? 'On' : 'Off'}</div><div className="l">Atrium AI</div></div>
              <div className="ai-kpi">
                <div className="v">{usd(status.budget?.userUsedUsd)}</div>
                <div className="l">Your usage this month{status.budget?.userLimitUsd != null ? ` of ${usd(status.budget.userLimitUsd)}` : ''}</div>
              </div>
            </div>
          </>
        )}
      </div>
    );
  }
  if (q.isError) return <div><h2>AI</h2><div className="muted">Atrium AI isn’t available on this server yet.</div></div>;
  if (!f) return <div><h2>AI</h2><div className="spinner" /></div>;

  const set = <K extends keyof AiSettings>(k: K, v: AiSettings[K]) => setF({ ...f, [k]: v });
  const envKey = f.apiKey.source === 'env';
  const save = async () => {
    setBusy(true);
    try {
      const { apiKey: _k, ...rest } = f;
      const saved = normalize(await put('/admin/ai/settings', { ...rest, ...(key ? { apiKey: key } : {}) }));
      setF(saved);
      setKey('');
      queryClient.setQueryData(['ai-settings'], saved);
      queryClient.invalidateQueries({ queryKey: ['ai-status'] });
      toast('AI settings saved');
    } catch (e: any) {
      toast(e.message);
    }
    setBusy(false);
  };
  const runTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      const r = await post<{ ok: boolean; model?: string; latencyMs?: number; error?: string }>('/admin/ai/test');
      setTest(r.ok ? { ok: true, text: `Connected · ${r.model ?? ''}${r.latencyMs ? ` · ${r.latencyMs} ms` : ''}` } : { ok: false, text: r.error ?? 'Connection failed' });
    } catch (e: any) {
      setTest({ ok: false, text: e.message });
    }
    setTesting(false);
  };
  const budgetInput = (v: number | null, on: (n: number | null) => void) => (
    <input className="input" style={{ width: 140 }} type="number" min={0} step={5} placeholder="No limit" value={v ?? ''} onChange={(e) => on(e.target.value === '' ? null : Number(e.target.value))} />
  );

  return (
    <div>
      <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Sparkles size={18} className="ai-sparkle" /> AI</h2>
      <div className="muted" style={{ marginBottom: 16, fontSize: 13 }}>
        One provider for the whole workspace. Keys are stored encrypted on the server and never sent to browsers. AI only reads pages the person using it can access.
      </div>

      <div className="ai-set-grid">
        <label>Atrium AI</label>
        <div className="ai-set-row"><Toggle checked={f.enabled} onChange={(v) => set('enabled', v)} /> <span className="muted" style={{ fontSize: 13 }}>{f.enabled ? 'On for allowed roles' : 'Off for everyone'}</span></div>

        <label htmlFor="ai-provider">Provider</label>
        <select id="ai-provider" className="select" value={f.provider} onChange={(e) => set('provider', e.target.value as AiSettings['provider'])}>
          <option value="anthropic">Anthropic (API key)</option>
          <option value="bedrock">Amazon Bedrock (IAM role)</option>
          {(import.meta.env.DEV || f.provider === 'mock' || (f as any).mockAvailable) && <option value="mock">Mock (development only)</option>}
        </select>

        {f.provider === 'anthropic' && (
          <>
            <label htmlFor="ai-key">API key</label>
            {envKey ? (
              <div className="muted" style={{ fontSize: 13 }}>Set via environment variable{f.apiKey.last4 ? ` (••••${f.apiKey.last4})` : ''} — change it in the deployment, not here.</div>
            ) : (
              <div className="ai-set-row">
                <input id="ai-key" className="input" style={{ width: 280 }} type="password" autoComplete="off" placeholder={f.apiKey.set ? `••••${f.apiKey.last4 ?? ''} · stored encrypted` : 'sk-ant-…'} value={key} onChange={(e) => setKey(e.target.value)} />
                {f.apiKey.set && <button className="btn sm" onClick={async () => { try { setF(normalize(await put('/admin/ai/settings', { apiKey: '' }))); toast('Key removed'); } catch (e: any) { toast(e.message); } }}>Remove</button>}
              </div>
            )}
          </>
        )}
        {f.provider === 'bedrock' && (
          <>
            <label htmlFor="ai-region">Bedrock region</label>
            <div className="ai-set-row">
              <input id="ai-region" className="input" style={{ width: 160 }} value={f.bedrockRegion ?? ''} placeholder="eu-west-1" onChange={(e) => set('bedrockRegion', e.target.value || null)} />
              <span className="faint" style={{ fontSize: 12 }}>Uses the server’s AWS role (e.g. the ECS task role). No keys needed.</span>
            </div>
          </>
        )}

        <label htmlFor="ai-smart">Main model</label>
        <div className="ai-set-row"><input id="ai-smart" className="input" style={{ width: 220 }} value={f.models.smart} placeholder={DEFAULT_MODELS.smart} onChange={(e) => set('models', { ...f.models, smart: e.target.value })} /><span className="faint" style={{ fontSize: 12 }}>Chat, agents, writing</span></div>
        <label htmlFor="ai-fast">Fast model</label>
        <div className="ai-set-row"><input id="ai-fast" className="input" style={{ width: 220 }} value={f.models.fast} placeholder={DEFAULT_MODELS.fast} onChange={(e) => set('models', { ...f.models, fast: e.target.value })} /><span className="faint" style={{ fontSize: 12 }}>Autofill, short rewrites</span></div>

        <label>Connection</label>
        <div className="ai-set-row">
          <button className="btn sm" onClick={runTest} disabled={testing}>{testing ? <Loader2 size={13} className="spin" /> : null} Test connection</button>
          {test && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 13, color: test.ok ? 'var(--c-green)' : 'var(--danger)' }}>{test.ok ? <CheckCircle2 size={14} /> : <AlertCircle size={14} />} {test.text}</span>}
        </div>
      </div>

      <h3 className="set-h3">Features</h3>
      <div className="ai-set-grid">
        {FEATURES.map((x) => (
          <div key={x.id} style={{ display: 'contents' }}>
            <label>{x.label}</label>
            <div className="ai-set-row"><Toggle checked={!!f.features[x.id]} onChange={(v) => set('features', { ...f.features, [x.id]: v })} /><span className="faint" style={{ fontSize: 12 }}>{x.hint}</span></div>
          </div>
        ))}
        <label>Who can use AI</label>
        <div className="ai-set-row">
          {ROLES.map((r) => (
            <label key={r} className="adm-check" style={{ margin: 0 }}>
              <input type="checkbox" checked={f.allowedRoles.includes(r)} onChange={(e) => set('allowedRoles', e.target.checked ? [...f.allowedRoles, r] : f.allowedRoles.filter((x) => x !== r))} /> {r[0].toUpperCase() + r.slice(1)}s
            </label>
          ))}
        </div>
      </div>

      <h3 className="set-h3">Budgets</h3>
      <div className="ai-set-grid">
        <label>Workspace per month (USD)</label>
        <div className="ai-set-row">{budgetInput(f.monthlyBudgetUsd, (n) => set('monthlyBudgetUsd', n))}{status?.budget && <span className="faint" style={{ fontSize: 12 }}>{usd(status.budget.usedUsd)} used this month</span>}</div>
        <label>Per person per month (USD)</label>
        <div className="ai-set-row">{budgetInput(f.perUserMonthlyBudgetUsd, (n) => set('perUserMonthlyBudgetUsd', n))}<span className="faint" style={{ fontSize: 12 }}>AI stops for that person once reached</span></div>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 28 }}>
        <button className="btn primary" disabled={busy} onClick={save}>Save changes</button>
        <button className="btn" disabled={busy} onClick={() => { setF(q.data ?? f); setKey(''); }}>Reset</button>
      </div>

      <h3 className="set-h3">Usage</h3>
      <Usage />
    </div>
  );
}
