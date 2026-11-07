import { useState } from 'react';
import { createReactBlockSpec } from '@blocknote/react';
import { Bookmark, Globe, Link as LinkIcon } from 'lucide-react';
import { get } from '../../lib/api';
import { toast } from '../ui';
import { isolate } from './context';

const host = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return u;
  }
};

const normalizeUrl = (raw: string) => {
  const s = raw.trim();
  if (!s) return '';
  return /^https?:\/\//i.test(s) ? s : `https://${s}`;
};

function UrlInput({ placeholder, button, onSubmit, icon }: { placeholder: string; button: string; onSubmit: (url: string) => Promise<void> | void; icon: React.ReactNode }) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="block-url-input"
      ref={isolate}
      onSubmit={async (e) => {
        e.preventDefault();
        const u = normalizeUrl(url);
        if (!u) return;
        setBusy(true);
        try {
          await onSubmit(u);
        } finally {
          setBusy(false);
        }
      }}
    >
      <span className="faint">{icon}</span>
      <input className="input" placeholder={placeholder} value={url} onChange={(e) => setUrl(e.target.value)} />
      <button className="btn primary sm" disabled={busy || !url.trim()}>{busy ? '…' : button}</button>
    </form>
  );
}

export async function unfurl(url: string) {
  try {
    return await get<{ url: string; title: string; description: string; image: string; favicon: string }>(`/unfurl?url=${encodeURIComponent(url)}`);
  } catch (e: any) {
    toast(e.message || 'Could not load link preview');
    return { url, title: '', description: '', image: '', favicon: '' };
  }
}

export const bookmarkBlock = createReactBlockSpec(
  {
    type: 'bookmark',
    propSchema: { url: { default: '' }, title: { default: '' }, description: { default: '' }, image: { default: '' }, favicon: { default: '' } },
    content: 'none',
  },
  {
    render: ({ block, editor }) => {
      const p = block.props;
      if (!p.url) {
        if (!editor.isEditable) return <div className="faint">Empty bookmark</div>;
        return (
          <UrlInput placeholder="Paste in https://…" button="Create bookmark" icon={<Bookmark size={16} />} onSubmit={async (url) => {
            const meta = await unfurl(url);
            editor.updateBlock(block, { props: { ...meta, url } as any });
          }} />
        );
      }
      return (
        <a className="bookmark" href={p.url} target="_blank" rel="noopener noreferrer" contentEditable={false}>
          <div className="bookmark-text">
            <div className="bookmark-title">{p.title || p.url}</div>
            {p.description && <div className="bookmark-desc">{p.description}</div>}
            <div className="bookmark-url">
              {p.favicon ? <img src={p.favicon} alt="" onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')} /> : <Globe size={12} />}
              <span>{p.url}</span>
            </div>
          </div>
          {p.image && <div className="bookmark-img"><img src={p.image} alt="" onError={(e) => ((e.target as HTMLImageElement).parentElement!.style.display = 'none')} /></div>}
        </a>
      );
    },
  },
);

/** Converts a pasted URL to something that can be iframed. `null` = not embeddable (fallback to bookmark). */
export function toEmbed(raw: string): { src?: string; srcDoc?: string; sameOrigin: boolean } | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const h = u.hostname.replace(/^www\./, '');
  const p = u.pathname;
  const ok = (src: string) => ({ src, sameOrigin: true });
  if (h === 'twitter.com' || h === 'x.com') return null;
  if (h === 'youtube.com' || h === 'm.youtube.com') {
    const id = u.searchParams.get('v') ?? p.match(/^\/(?:embed|shorts|live)\/([\w-]+)/)?.[1];
    if (id) return ok(`https://www.youtube-nocookie.com/embed/${id}`);
  }
  if (h === 'youtu.be') return ok(`https://www.youtube-nocookie.com/embed/${p.slice(1)}`);
  if (h === 'vimeo.com') {
    const id = p.match(/\/(\d+)/)?.[1];
    if (id) return ok(`https://player.vimeo.com/video/${id}`);
  }
  if (h === 'loom.com') {
    const id = p.match(/\/(?:share|embed)\/([\w-]+)/)?.[1];
    if (id) return ok(`https://www.loom.com/embed/${id}`);
  }
  if (h === 'figma.com') return ok(`https://www.figma.com/embed?embed_host=atrium&url=${encodeURIComponent(raw)}`);
  if (h === 'docs.google.com') {
    const m = p.match(/^\/(document|spreadsheets|presentation|forms)\/d\/([\w-]+)/);
    if (m) return ok(`https://docs.google.com/${m[1]}/d/${m[2]}/${m[1] === 'presentation' ? 'embed' : m[1] === 'forms' ? 'viewform?embedded=true' : 'preview'}`);
  }
  if ((h === 'google.com' || h === 'maps.google.com') && (p.startsWith('/maps') || h.startsWith('maps'))) {
    if (p.startsWith('/maps/embed')) return ok(raw);
    const place = p.match(/\/maps\/(?:place|search)\/([^/]+)/)?.[1];
    const at = p.match(/@(-?[\d.]+),(-?[\d.]+)/);
    const q = place ? decodeURIComponent(place.replace(/\+/g, ' ')) : at ? `${at[1]},${at[2]}` : u.searchParams.get('q') ?? '';
    return ok(`https://maps.google.com/maps?q=${encodeURIComponent(q)}&output=embed`);
  }
  if (h === 'miro.com') {
    const id = p.match(/\/app\/board\/([^/]+)/)?.[1];
    if (id) return ok(`https://miro.com/app/live-embed/${id}/`);
  }
  if (h === 'codepen.io') {
    const m = p.match(/^\/([^/]+)\/(?:pen|full|details)\/([^/]+)/);
    if (m) return ok(`https://codepen.io/${m[1]}/embed/${m[2]}?default-tab=result`);
  }
  if (h === 'gist.github.com') {
    const m = p.match(/^\/([^/]+)\/([0-9a-f]+)/);
    if (m) {
      return {
        srcDoc: `<!doctype html><html><head><base target="_blank"><style>body{margin:0}</style></head><body><script src="https://gist.github.com/${m[1]}/${m[2]}.js"></script></body></html>`,
        sameOrigin: false,
      };
    }
  }
  // Never give our own origin same-origin powers inside a frame.
  return { src: raw, sameOrigin: u.origin !== location.origin };
}

function EmbedFrame({ block, editor }: { block: any; editor: any }) {
  const e = toEmbed(block.props.url);
  if (!e) return null;
  const startResize = (ev: React.MouseEvent) => {
    ev.preventDefault();
    const y0 = ev.clientY;
    const h0 = Number(block.props.height) || 400;
    const frame = (ev.currentTarget as HTMLElement).parentElement!.querySelector('iframe')!;
    let h = h0;
    const move = (m: MouseEvent) => {
      h = Math.max(120, Math.min(1600, h0 + m.clientY - y0));
      frame.style.height = `${h}px`;
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      editor.updateBlock(block, { props: { height: Math.round(h) } });
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  return (
    <div className="embed" contentEditable={false}>
      <iframe
        title={host(block.props.url)}
        src={e.src}
        srcDoc={e.srcDoc}
        style={{ height: Number(block.props.height) || 400 }}
        sandbox={`allow-scripts allow-popups allow-forms allow-presentation allow-popups-to-escape-sandbox${e.sameOrigin ? ' allow-same-origin' : ''}`}
        allow="fullscreen; clipboard-write; encrypted-media; picture-in-picture"
        loading="lazy"
        referrerPolicy="strict-origin-when-cross-origin"
      />
      <div className="embed-caption"><LinkIcon size={12} /> <a href={block.props.url} target="_blank" rel="noopener noreferrer">{host(block.props.url)}</a></div>
      {editor.isEditable && <div className="embed-resizer" onMouseDown={startResize} />}
    </div>
  );
}

export const embedBlock = createReactBlockSpec(
  { type: 'embed', propSchema: { url: { default: '' }, height: { default: 400 } }, content: 'none' },
  {
    render: ({ block, editor }) => {
      if (!block.props.url) {
        if (!editor.isEditable) return <div className="faint">Empty embed</div>;
        return (
          <UrlInput placeholder="Paste a link to embed (YouTube, Figma, Google Docs, Maps, Loom…)" button="Embed link" icon={<Globe size={16} />} onSubmit={async (url) => {
            if (!toEmbed(url)) {
              // e.g. X/Twitter refuses framing — show it as a bookmark instead.
              const meta = await unfurl(url);
              editor.updateBlock(block, { type: 'bookmark', props: { ...meta, url } } as any);
              return;
            }
            editor.updateBlock(block, { props: { url } });
          }} />
        );
      }
      return <EmbedFrame block={block} editor={editor} />;
    },
  },
);
