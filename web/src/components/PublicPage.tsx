import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Mail } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useCreateBlockNote } from '@blocknote/react';
import { BlockNoteView } from '@blocknote/mantine';
import { PageIcon } from './ui';
import { coverStyle, isImageCover } from './PagePickers';

/** Convert custom blocks into default ones so the read-only viewer needs no app context. */
const txt = (text: string, styles: Record<string, any> = {}) => ({ type: 'text', text, styles });
const linkPara = (href: string, label: string, kids: any[] = []) => ({ type: 'paragraph', content: [{ type: 'link', href, content: label }], children: kids });

function simplifyInline(c: any) {
  if (c.type === 'mention') {
    if (c.props.kind === 'date') return txt(`@${c.props.date ? new Date(c.props.date.includes('T') ? c.props.date : `${c.props.date}T00:00:00`).toLocaleString(undefined, c.props.date.includes('T') ? { dateStyle: 'long', timeStyle: 'short' } : { dateStyle: 'long' }) : ''}`);
    return txt(`${c.props.kind === 'user' ? '@' : ''}${c.props.label}`);
  }
  if (c.type === 'inlineEquation') return txt(c.props.latex, { code: true });
  if (c.styles?.comment) return { ...c, styles: { ...c.styles, comment: undefined } };
  return c;
}

function simplify(blocks: any[]): any[] {
  const out: any[] = [];
  for (const b of blocks) {
    const kids = simplify(b.children ?? []);
    switch (b.type) {
      case 'subpage': out.push(linkPara(`/share/${b.props.pageId}`, b.props.title || 'Sub-page', kids)); break;
      case 'toc': case 'breadcrumb': case 'button': case 'syncedBlock': break; // need app context; omitted publicly
      case 'callout': {
        // Image icons (uploaded/custom) are URLs — render them as an image before the quote rather than as text.
        const isImg = /^(\/|https?:)/.test(b.props.emoji ?? '');
        if (isImg) out.push({ type: 'image', props: { url: b.props.emoji, previewWidth: 28 }, children: [] });
        out.push({ type: 'quote', content: [...(isImg || !b.props.emoji ? [] : [txt(`${b.props.emoji} `)]), ...(b.content ?? []).map(simplifyInline)], children: kids });
        break;
      }
      case 'columnList': case 'column': out.push(...kids); break;
      case 'bookmark': if (b.props.url) out.push(linkPara(b.props.url, b.props.title || b.props.url)); break;
      case 'embed': if (b.props.url) out.push(linkPara(b.props.url, b.props.url)); break;
      case 'equation': if (b.props.latex) out.push({ type: 'codeBlock', props: { language: 'latex' }, content: b.props.latex, children: [] }); break;
      case 'database': out.push(linkPara(`/share/${b.props.databaseId}`, 'Database')); break;
      default: out.push({ ...b, content: Array.isArray(b.content) ? b.content.map(simplifyInline) : b.content, children: kids });
    }
  }
  return out;
}

function Viewer({ blocks }: { blocks: any[] }) {
  const editor = useCreateBlockNote({ initialContent: blocks.length ? simplify(blocks) : undefined });
  return <BlockNoteView editor={editor} editable={false} theme={document.documentElement.classList.contains('dark') ? 'dark' : 'light'} />;
}

/** Fetch a public page; returns HTTP status so we can show the password gate / not-found states. */
async function fetchPublic(slug: string) {
  const res = await fetch(`/api/v1/public/pages/${encodeURIComponent(slug)}`, { credentials: 'same-origin' });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

function useNoIndex() {
  useEffect(() => {
    const m = document.createElement('meta');
    m.name = 'robots';
    m.content = 'noindex, nofollow';
    document.head.appendChild(m);
    return () => m.remove();
  }, []);
}

function Gate({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="pub-gate">
      <div className="auth-card">
        <div className="auth-logo">A</div>
        <h1 style={{ fontSize: 22 }}>{title}</h1>
        {children}
      </div>
    </div>
  );
}

function PasswordGate({ slug, onUnlocked }: { slug: string; onUnlocked: () => void }) {
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Gate title="This page is password protected">
      <form
        style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setErr('');
          const res = await fetch(`/api/v1/public/pages/${encodeURIComponent(slug)}/unlock`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: pw }), credentials: 'same-origin',
          });
          setBusy(false);
          if (res.ok) onUnlocked();
          else setErr((await res.json().catch(() => ({}))).error ?? 'Incorrect password');
        }}
      >
        <div className="muted" style={{ fontSize: 14 }}>Enter the password you were given to view it.</div>
        <input className="input" type="password" autoFocus placeholder="Password" value={pw} onChange={(e) => setPw(e.target.value)} />
        {err && <div className="auth-error">{err}</div>}
        <button className="btn primary" disabled={busy || !pw}>View page</button>
      </form>
    </Gate>
  );
}

export default function PublicPage() {
  const { slug = '' } = useParams();
  useNoIndex();
  const { data, refetch, isLoading } = useQuery({ queryKey: ['public', slug], queryFn: () => fetchPublic(slug), retry: false });
  if (isLoading || !data) return null;
  if (data.status === 401 && data.body.needsPassword) return <PasswordGate slug={slug} onUnlocked={() => refetch()} />;
  if (data.status !== 200) {
    return (
      <Gate title="Page not available">
        <div className="muted" style={{ fontSize: 14 }}>This link isn't shared, has expired, or access was removed. Ask the person who shared it for a new link.</div>
      </Gate>
    );
  }
  const page = data.body;
  document.title = page.title || 'Untitled';
  const crumbs: { id: string; title: string; icon: string | null }[] = (page.crumbs ?? []).filter(Boolean);
  return (
    <div className="scroller" style={{ height: '100vh' }}>
      {page.sharedWith && (
        <div className="pub-banner"><Mail size={13} /> Shared with {page.sharedWith} · view only</div>
      )}
      {page.via === 'member' && (
        <div className="pub-banner">You're signed in — <Link to={`/p/${page.id}`}>open this page in Atrium</Link></div>
      )}
      {crumbs.length > 1 && (
        <nav className="pub-crumbs">
          {crumbs.map((c, i) => (
            <span key={c.id} style={{ display: 'contents' }}>
              {i > 0 && <span className="faint">/</span>}
              <Link to={`/share/${c.id}`}><PageIcon icon={c.icon} size={15} />{c.title || 'Untitled'}</Link>
            </span>
          ))}
        </nav>
      )}
      {page.cover && <div className="page-cover" style={coverStyle(page.cover)}>{isImageCover(page.cover) && <img src={page.cover} alt="" style={{ objectPosition: `center ${page.cover_position}%` }} />}</div>}
      <div className={`page-inner ${page.full_width ? 'full' : ''}`}>
        <div className={`page-header ${page.cover ? 'has-cover' : ''} ${page.icon ? 'has-icon' : ''}`}>
          {page.icon && <div className="page-icon-big" style={{ cursor: 'default' }}><PageIcon icon={page.icon} size={78} /></div>}
          <h1 className="page-title">{page.title || 'Untitled'}</h1>
        </div>
        {page.database ? (
          <table className="public-db">
            <thead><tr>{page.database.schema.map((p: any) => <th key={p.id}>{p.name}</th>)}</tr></thead>
            <tbody>
              {page.database.rows.map((r: any) => (
                <tr key={r.id}>{page.database.schema.map((p: any) => (
                  <td key={p.id}>
                    {p.type === 'title'
                      ? <Link className="pub-row-link" to={`/share/${r.id}`}><PageIcon icon={r.icon} size={14} />{r.title || 'Untitled'}</Link>
                      : formatPublicValue(p, r, page.database)}
                  </td>
                ))}</tr>
              ))}
            </tbody>
          </table>
        ) : (
          <>
            {page.row && (
              <div className="pub-props">
                {page.row.schema.map((p: any) => {
                  const text = formatPublicValue(p, page.row.row, page.row);
                  return (
                    <div key={p.id} className="pub-prop">
                      <span className="pub-prop-name">{p.name}</span>
                      <span className={text ? '' : 'faint'}>{text || 'Empty'}</span>
                    </div>
                  );
                })}
              </div>
            )}
            <div className="page-body"><Viewer key={page.id} blocks={page.blocks} /></div>
          </>
        )}
        {!!page.children?.length && (
          <div style={{ marginBottom: 80 }}>
            {page.children.map((c: any) => <Link key={c.id} className="subpage-block" to={`/share/${c.id}`}><PageIcon icon={c.icon} size={20} /><span className="t">{c.title || 'Untitled'}</span></Link>)}
          </div>
        )}
        <div className="faint" style={{ fontSize: 12, padding: '40px 0', textAlign: 'center' }}>Shared with Atrium</div>
      </div>
    </div>
  );
}

/** /x/:token — personal email link. Redeems it (optionally with an emailed code), then opens the page. */
export function MagicLink() {
  const { token = '' } = useParams();
  const nav = useNavigate();
  useNoIndex();
  const [state, setState] = useState<{ kind: 'loading' } | { kind: 'code'; hint: string } | { kind: 'error'; msg: string }>({ kind: 'loading' });
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');
  const call = async (path: string, body: object) => {
    const res = await fetch(`/api/v1/public/external/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin' });
    return { ok: res.ok, body: await res.json().catch(() => ({})) };
  };
  const redeem = async () => {
    const r = await call('redeem', { token });
    if (!r.ok) setState({ kind: 'error', msg: r.body.error ?? 'This link is no longer valid.' });
    else if (r.body.needsCode) setState({ kind: 'code', hint: r.body.emailHint });
    else nav(`/share/${r.body.pageId}`, { replace: true });
  };
  useEffect(() => {
    redeem();
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps
  if (state.kind === 'loading') return null;
  if (state.kind === 'error') {
    return (
      <Gate title="Link not available">
        <div className="muted" style={{ fontSize: 14 }}>{state.msg}</div>
        <div className="faint" style={{ fontSize: 12 }}>Ask the person who shared it to send you a new link.</div>
      </Gate>
    );
  }
  return (
    <Gate title="Check your email">
      <form
        style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
        onSubmit={async (e) => {
          e.preventDefault();
          setErr('');
          const r = await call('verify', { token, code });
          if (r.ok) nav(`/share/${r.body.pageId}`, { replace: true });
          else setErr(r.body.error ?? 'Incorrect code');
        }}
      >
        <div className="muted" style={{ fontSize: 14 }}>We sent a 6-digit code to <b>{state.hint}</b>. Enter it to open the page.</div>
        <input className="input" inputMode="numeric" autoComplete="one-time-code" autoFocus maxLength={6} placeholder="123456" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} style={{ letterSpacing: 4, fontSize: 18 }} />
        {err && <div className="auth-error">{err}</div>}
        <button className="btn primary" disabled={code.length !== 6}>Continue</button>
        <button type="button" className="link-btn" style={{ fontSize: 12, textAlign: 'left' }} onClick={() => { setCode(''); setErr(''); redeem(); }}>Send a new code</button>
      </form>
    </Gate>
  );
}

/** Plain-text rendering of a database value for read-only shared views (names only — never emails). */
function formatPublicValue(p: any, r: any, ctx: { titles?: Record<string, string>; people?: Record<string, string> }): string {
  const v = p.type === 'formula' || p.type === 'rollup' ? r.computed?.[p.id]
    : p.type === 'created_time' ? r.created_at
    : p.type === 'last_edited_time' ? r.updated_at
    : p.type === 'created_by' ? [r.created_by]
    : p.type === 'last_edited_by' ? [r.updated_by]
    : r.props?.[p.id];
  if (v == null || v === '') return '';
  const opt = (id: string) => p.options?.find((o: any) => o.id === id)?.name ?? '';
  const date = (s: string) => new Date(s).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  const one = (x: any): string =>
    x == null ? '' : typeof x === 'object' ? (x.error ? '' : x.title ?? x.name ?? (x.start ? date(x.start) + (x.end ? ` → ${date(x.end)}` : '') : '')) : String(x);
  switch (p.type) {
    case 'select': case 'status': return opt(v);
    case 'multi_select': return (v as string[]).map(opt).join(', ');
    case 'person': case 'created_by': case 'last_edited_by': return (v as string[]).map((id) => ctx.people?.[id] ?? '').filter(Boolean).join(', ');
    case 'relation': return (v as string[]).map((id) => ctx.titles?.[id] || 'Untitled').join(', ');
    case 'date': return v.start ? date(v.start) + (v.end ? ` → ${date(v.end)}` : '') : '';
    case 'created_time': case 'last_edited_time': return date(v);
    case 'checkbox': return v ? '✓' : '';
    case 'files': return (v as any[]).map((f) => f.name).join(', ');
    case 'unique_id': return `${p.id_prefix ? `${p.id_prefix}-` : ''}${v}`;
    default: return Array.isArray(v) ? v.map(one).join(', ') : one(v);
  }
}
