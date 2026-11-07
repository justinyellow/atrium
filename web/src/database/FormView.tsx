import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Check, Copy, Eye, Globe, Lock, Pencil, Plus, Trash2, Upload, CircleCheck } from 'lucide-react';
import { get, post, uploadFile } from '../lib/api';
import { useUsers } from '../lib/hooks';
import type { FormConfig, FormQuestion, Prop } from '../lib/types';
import { toast } from '../components/ui';
import { TypeIcon } from './cells';
import { updateView } from './dbutil';
import type { ViewProps } from './shared';

/** What the server returns for a form (members: GET /databases/:id/forms/:viewId; public: GET /public/forms/:slug). */
export interface FormMeta {
  viewId: string;
  title: string;
  description: string;
  submitLabel: string;
  thankYou: string;
  access: 'members' | 'link';
  questions: (FormQuestion & { prop: Pick<Prop, 'id' | 'name' | 'type' | 'options' | 'number_format' | 'limit'> & { relation?: { databaseId: string } } })[];
}

const ANSWERABLE = ['title', 'text', 'number', 'select', 'multi_select', 'status', 'date', 'checkbox', 'url', 'email', 'phone', 'place', 'person', 'files', 'relation'];
const PUBLIC_OK = ['title', 'text', 'number', 'select', 'multi_select', 'status', 'date', 'checkbox', 'url', 'email', 'phone', 'place'];

function RelationSelect({ databaseId, value, onChange }: { databaseId: string; value: string[]; onChange: (v: string[]) => void }) {
  const { data } = useQuery({ queryKey: ['dbq', databaseId, 'form-rel'], queryFn: () => post<{ rows: { id: string; title: string }[] }>(`/databases/${databaseId}/query`, {}) });
  return (
    <select className="input" multiple value={value} onChange={(e) => onChange([...e.target.selectedOptions].map((o) => o.value))} size={Math.min(6, Math.max(3, data?.rows.length ?? 3))}>
      {(data?.rows ?? []).map((r) => <option key={r.id} value={r.id}>{r.title || 'Untitled'}</option>)}
    </select>
  );
}

function AnswerInput({ q, value, onChange, publicMode, inputId }: { q: FormMeta['questions'][number]; value: any; onChange: (v: any) => void; publicMode: boolean; inputId: string }) {
  const p = q.prop;
  const users = useUsers();
  switch (p.type) {
    case 'title':
    case 'url': case 'email': case 'phone':
      return <input id={inputId} className="input" type={p.type === 'email' ? 'email' : p.type === 'url' ? 'url' : p.type === 'phone' ? 'tel' : 'text'} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
    case 'text': return <textarea id={inputId} className="input" rows={3} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
    case 'number': return <input id={inputId} className="input" type="number" value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))} />;
    case 'date': return <input id={inputId} className="input" type="date" value={value?.start ?? value ?? ''} onChange={(e) => onChange(e.target.value ? { start: e.target.value } : '')} />;
    case 'checkbox': return <label className="form-check"><input id={inputId} type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} /> Yes</label>;
    case 'select': case 'status':
      return (p.options?.length ?? 0) <= 6 ? (
        <div className="form-options" role="radiogroup" id={inputId}>
          {p.options?.map((o) => (
            <label key={o.id} className={`form-option ${value === o.id ? 'on' : ''}`}>
              <input type="radio" name={inputId} checked={value === o.id} onChange={() => onChange(o.id)} /> <span className={`tag c-${o.color || 'default'}`}>{o.name}</span>
            </label>
          ))}
        </div>
      ) : (
        <select id={inputId} className="input" value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
          <option value="">Select an option…</option>
          {p.options?.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
      );
    case 'multi_select': {
      const arr: string[] = Array.isArray(value) ? value : [];
      return (
        <div className="form-options" id={inputId}>
          {p.options?.map((o) => (
            <label key={o.id} className={`form-option ${arr.includes(o.id) ? 'on' : ''}`}>
              <input type="checkbox" checked={arr.includes(o.id)} onChange={() => onChange(arr.includes(o.id) ? arr.filter((x) => x !== o.id) : [...arr, o.id])} /> <span className={`tag c-${o.color || 'default'}`}>{o.name}</span>
            </label>
          ))}
        </div>
      );
    }
    case 'place':
      return (
        <div className="place-coords" id={inputId}>
          <input className="input" placeholder="Name" value={value?.name ?? ''} onChange={(e) => onChange({ ...(value ?? {}), name: e.target.value })} />
          <input className="input" placeholder="Latitude" inputMode="decimal" value={value?.lat ?? ''} onChange={(e) => onChange({ ...(value ?? {}), lat: e.target.value })} />
          <input className="input" placeholder="Longitude" inputMode="decimal" value={value?.lng ?? ''} onChange={(e) => onChange({ ...(value ?? {}), lng: e.target.value })} />
        </div>
      );
    case 'person':
      if (publicMode) return null;
      return (
        <select id={inputId} className="input" value={Array.isArray(value) ? value[0] ?? '' : ''} onChange={(e) => onChange(e.target.value ? [e.target.value] : [])}>
          <option value="">Select a person…</option>
          {(users.data ?? []).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
      );
    case 'files':
      if (publicMode) return null;
      return (
        <div id={inputId}>
          {(Array.isArray(value) ? value : []).map((f: any, i: number) => <div key={i} className="faint" style={{ fontSize: 13 }}>{f.name}</div>)}
          <label className="btn sm"><Upload size={13} /> Upload<input type="file" hidden onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            try { const up = await uploadFile(file); onChange([...(Array.isArray(value) ? value : []), { name: up.name, url: up.url, mime: up.mime }]); } catch (err: any) { toast(err.message); }
          }} /></label>
        </div>
      );
    case 'relation':
      if (publicMode || !p.relation) return null;
      return <RelationSelect databaseId={p.relation.databaseId} value={Array.isArray(value) ? value : []} onChange={onChange} />;
    default: return null;
  }
}

/** Fill-in form (members preview/submit and the public /f/<slug> page). */
export function FormRunner({ meta, publicMode, submit, preview }: { meta: FormMeta; publicMode: boolean; submit: (answers: Record<string, any>) => Promise<{ thankYou?: string }>; preview?: boolean }) {
  const [answers, setAnswers] = useState<Record<string, any>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  if (done != null) {
    return (
      <div className="form-card form-done">
        <CircleCheck size={36} className="form-done-icon" />
        <p>{done}</p>
        <button className="btn" onClick={() => { setAnswers({}); setDone(null); }}>Submit another response</button>
      </div>
    );
  }
  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const missing: Record<string, string> = {};
    for (const q of meta.questions) {
      const v = answers[q.propId];
      if (q.required && (v == null || v === '' || (Array.isArray(v) && !v.length) || (q.prop.type === 'checkbox' && !v))) missing[q.propId] = 'Required';
    }
    setErrors(missing);
    if (Object.keys(missing).length) return;
    setBusy(true);
    try {
      const r = await submit(answers);
      setDone(r.thankYou || meta.thankYou);
    } catch (err: any) {
      // Server field errors come back as { fields: { propId: message } }
      const fields = err?.body?.fields;
      if (fields) setErrors(fields);
      toast(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="form-card" onSubmit={onSubmit} noValidate>
      <h2 className="form-title">{meta.title}</h2>
      {meta.description && <p className="form-desc">{meta.description}</p>}
      {meta.questions.map((q) => {
        const id = `fq-${q.propId}`;
        const input = <AnswerInput q={q} value={answers[q.propId]} onChange={(v) => setAnswers({ ...answers, [q.propId]: v })} publicMode={publicMode} inputId={id} />;
        if (!input) return null;
        return (
          <div key={q.propId} className={`form-q ${errors[q.propId] ? 'has-error' : ''}`}>
            <label className="form-q-label" htmlFor={id}>{q.label || q.prop.name}{q.required && <span className="form-req" aria-label="required"> *</span>}</label>
            {q.description && <div className="form-q-desc">{q.description}</div>}
            {input}
            {errors[q.propId] && <div className="form-err" role="alert">{errors[q.propId]}</div>}
          </div>
        );
      })}
      {!meta.questions.length && <p className="faint">This form has no questions yet.</p>}
      <button className="btn primary" disabled={busy || preview || !meta.questions.length}>{meta.submitLabel}</button>
      {preview && <div className="faint" style={{ fontSize: 12 }}>Preview — switch to “Fill out” to submit a response.</div>}
    </form>
  );
}

function QuestionEditor({ q, prop, onChange, onRemove, onMove, first, last, publicForm }: {
  q: FormQuestion; prop: Prop; onChange: (q: FormQuestion) => void; onRemove: () => void; onMove: (d: -1 | 1) => void; first: boolean; last: boolean; publicForm: boolean;
}) {
  return (
    <div className="fb-q">
      <div className="fb-q-head">
        <TypeIcon type={prop.type} /> <span className="fb-q-prop">{prop.name}</span>
        {publicForm && !PUBLIC_OK.includes(prop.type) && <span className="fb-warn" title="Hidden on the public link">Members only</span>}
        <span style={{ flex: 1 }} />
        <button className="icon-btn" disabled={first} onClick={() => onMove(-1)} aria-label="Move up"><ArrowUp size={14} /></button>
        <button className="icon-btn" disabled={last} onClick={() => onMove(1)} aria-label="Move down"><ArrowDown size={14} /></button>
        <button className="icon-btn" onClick={onRemove} aria-label="Remove question"><Trash2 size={14} /></button>
      </div>
      <input className="input sm" placeholder={prop.name} defaultValue={q.label ?? ''} aria-label="Question" onBlur={(e) => onChange({ ...q, label: e.target.value || undefined })} />
      <input className="input sm" placeholder="Description (optional)" defaultValue={q.description ?? ''} aria-label="Question description" onBlur={(e) => onChange({ ...q, description: e.target.value || undefined })} />
      <label className="fb-req"><input type="checkbox" checked={!!q.required} onChange={(e) => onChange({ ...q, required: e.target.checked || undefined })} /> Required</label>
    </div>
  );
}

export function FormView({ db, view, canEdit }: ViewProps) {
  const form: FormConfig = view.config.form ?? { questions: [], access: 'members' };
  const [mode, setMode] = useState<'edit' | 'fill'>(canEdit ? 'edit' : 'fill');
  const save = (patch: Partial<FormConfig>) => updateView(db.id, view.id, { config: { form: { ...form, ...patch } } });
  const meta = useQuery({ queryKey: ['dbq', db.id, 'form', view.id, JSON.stringify(form)], queryFn: () => get<FormMeta>(`/databases/${db.id}/forms/${view.id}`) });
  const used = new Set(form.questions.map((q) => q.propId));
  const addable = useMemo(() => db.schema.filter((p) => ANSWERABLE.includes(p.type) && !used.has(p.id)), [db.schema, form.questions]); // eslint-disable-line react-hooks/exhaustive-deps
  const link = form.access === 'link' && form.slug ? `${location.origin}/f/${form.slug}` : null;
  useEffect(() => { if (!canEdit) setMode('fill'); }, [canEdit]);

  const runner = meta.data && (
    <FormRunner meta={meta.data} publicMode={false} preview={mode === 'edit'}
      submit={(answers) => post(`/databases/${db.id}/forms/${view.id}/submit`, { answers })} />
  );
  if (!canEdit || mode === 'fill') {
    return (
      <div className="form-view">
        {canEdit && <div className="fb-mode"><button className="btn sm" onClick={() => setMode('edit')}><Pencil size={13} /> Edit form</button></div>}
        {runner ?? <div className="db-loading"><div className="spinner" /></div>}
      </div>
    );
  }
  return (
    <div className="form-view form-builder">
      <div className="fb-panel">
        <div className="fb-mode">
          <button className="btn sm" onClick={() => setMode('fill')}><Eye size={13} /> Fill out</button>
        </div>
        <label className="fb-field">Title<input className="input sm" defaultValue={form.title ?? ''} placeholder={db.title || 'Form'} onBlur={(e) => save({ title: e.target.value || undefined })} /></label>
        <label className="fb-field">Description<textarea className="input sm" rows={2} defaultValue={form.description ?? ''} onBlur={(e) => save({ description: e.target.value || undefined })} /></label>
        <div className="menu-heading">Questions</div>
        {form.questions.map((q, i) => {
          const p = db.schema.find((x) => x.id === q.propId);
          if (!p) return null;
          return (
            <QuestionEditor key={q.propId} q={q} prop={p} first={i === 0} last={i === form.questions.length - 1} publicForm={form.access === 'link'}
              onChange={(nq) => save({ questions: form.questions.map((x, j) => (j === i ? nq : x)) })}
              onRemove={() => save({ questions: form.questions.filter((_, j) => j !== i) })}
              onMove={(d) => { const l = [...form.questions]; const [m] = l.splice(i, 1); l.splice(i + d, 0, m); save({ questions: l }); }} />
          );
        })}
        {!!addable.length && (
          <select className="input sm" value="" aria-label="Add a question" onChange={(e) => e.target.value && save({ questions: [...form.questions, { propId: e.target.value }] })}>
            <option value="">+ Add a question…</option>
            {addable.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        )}
        <div className="menu-heading">After submitting</div>
        <label className="fb-field">Button label<input className="input sm" defaultValue={form.submitLabel ?? ''} placeholder="Submit" onBlur={(e) => save({ submitLabel: e.target.value || undefined })} /></label>
        <label className="fb-field">Thank-you message<textarea className="input sm" rows={2} defaultValue={form.thankYou ?? ''} placeholder="Thanks — your response was recorded." onBlur={(e) => save({ thankYou: e.target.value || undefined })} /></label>
        <div className="menu-heading">Who can fill this out</div>
        <div className="fb-access" role="radiogroup">
          <button role="radio" aria-checked={form.access !== 'link'} className={`fb-access-opt ${form.access !== 'link' ? 'on' : ''}`} onClick={() => save({ access: 'members' })}><Lock size={14} /> Workspace members</button>
          <button role="radio" aria-checked={form.access === 'link'} className={`fb-access-opt ${form.access === 'link' ? 'on' : ''}`} onClick={() => save({ access: 'link' })}><Globe size={14} /> Anyone with the link</button>
        </div>
        {link && (
          <div className="token-box fb-link">
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{link}</span>
            <button className="icon-btn" title="Copy link" onClick={() => { navigator.clipboard?.writeText(link); toast('Form link copied'); }}><Copy size={14} /></button>
          </div>
        )}
        {form.access === 'link' && <div className="faint" style={{ fontSize: 12 }}>People, files and relation questions are only shown to signed-in members.</div>}
      </div>
      <div className="fb-preview">{runner ?? <div className="db-loading"><div className="spinner" /></div>}</div>
    </div>
  );
}

/** Public form page: /f/:slug */
export function PublicFormPage({ slug }: { slug: string }) {
  const meta = useQuery({ queryKey: ['public-form', slug], queryFn: () => get<FormMeta>(`/public/forms/${slug}`), retry: false });
  useEffect(() => {
    const m = document.createElement('meta');
    m.name = 'robots';
    m.content = 'noindex, nofollow';
    document.head.appendChild(m);
    return () => { m.remove(); };
  }, []);
  useEffect(() => { if (meta.data) document.title = meta.data.title; }, [meta.data]);
  if (meta.isLoading) return <div className="public-form"><div className="spinner" /></div>;
  if (meta.error || !meta.data) return <div className="public-form"><div className="form-card"><h2 className="form-title">Form not available</h2><p className="faint">This form doesn't exist or is no longer accepting responses.</p></div></div>;
  return (
    <div className="public-form">
      <FormRunner meta={meta.data} publicMode submit={(answers) => post(`/public/forms/${slug}/submit`, { answers })} />
      <div className="faint" style={{ fontSize: 12, textAlign: 'center', marginTop: 16 }}><Check size={12} /> Powered by Atrium</div>
    </div>
  );
}

export const PlusIcon = Plus;
