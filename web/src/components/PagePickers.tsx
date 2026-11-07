import { lazy, Suspense, useRef, useState } from 'react';
import { uploadFile } from '../lib/api';
import { Popover } from './ui';

const EmojiPicker = lazy(() => import('emoji-picker-react'));

const COMMON = ['📄', '📝', '📌', '🚀', '✅', '📚', '💡', '🎯', '📊', '🗂️', '🏠', '⭐', '🔥', '🧠', '📅', '💼', '🛠️', '🎨', '🧪', '🌱'];

export function IconPicker({ anchor, open, onClose, onPick }: { anchor: HTMLElement | null; open: boolean; onClose: () => void; onPick: (icon: string | null) => void }) {
  const [tab, setTab] = useState<'emoji' | 'upload'>('emoji');
  const file = useRef<HTMLInputElement>(null);
  const dark = document.documentElement.classList.contains('dark');
  return (
    <Popover anchor={anchor} open={open} onClose={onClose} width={360}>
      <div className="picker-tabs">
        <button className={tab === 'emoji' ? 'on' : ''} onClick={() => setTab('emoji')}>Emoji</button>
        <button className={tab === 'upload' ? 'on' : ''} onClick={() => setTab('upload')}>Upload</button>
        <span style={{ flex: 1 }} />
        <button onClick={() => onPick(COMMON[Math.floor(Math.random() * COMMON.length)])}>Random</button>
        <button onClick={() => onPick(null)}>Remove</button>
      </div>
      {tab === 'emoji' ? (
        <Suspense fallback={<div style={{ height: 380 }} />}>
          <EmojiPicker
            onEmojiClick={(e) => onPick(e.emoji)}
            width="100%"
            height={380}
            theme={(dark ? 'dark' : 'light') as any}
            previewConfig={{ showPreview: false }}
            skinTonesDisabled
            lazyLoadEmojis
          />
        </Suspense>
      ) : (
        <div style={{ padding: 16, textAlign: 'center' }}>
          <button className="btn" onClick={() => file.current?.click()}>Upload an image</button>
          <div className="faint" style={{ fontSize: 12, marginTop: 8 }}>Recommended size is 280 × 280 pixels</div>
          <input ref={file} type="file" accept="image/*" hidden onChange={async (e) => {
            const f = e.target.files?.[0];
            if (f) onPick((await uploadFile(f)).url);
          }} />
        </div>
      )}
    </Popover>
  );
}

export const GRADIENTS = [
  'linear-gradient(135deg, #f6d365 0%, #fda085 100%)',
  'linear-gradient(135deg, #a1c4fd 0%, #c2e9fb 100%)',
  'linear-gradient(135deg, #d4fc79 0%, #96e6a1 100%)',
  'linear-gradient(135deg, #fbc2eb 0%, #a6c1ee 100%)',
  'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
  'linear-gradient(135deg, #ff9a9e 0%, #fecfef 100%)',
  'linear-gradient(135deg, #43e97b 0%, #38f9d7 100%)',
  'linear-gradient(135deg, #30cfd0 0%, #330867 100%)',
  'linear-gradient(135deg, #e0c3fc 0%, #8ec5fc 100%)',
  'linear-gradient(135deg, #fa709a 0%, #fee140 100%)',
  'linear-gradient(135deg, #0f2027 0%, #2c5364 100%)',
  'linear-gradient(135deg, #ffecd2 0%, #fcb69f 100%)',
];
export const SOLIDS = ['#e16259', '#d9730d', '#dfab01', '#0f7b6c', '#0b6e99', '#6940a5', '#ad1a72', '#787774', '#efe6dc', '#dfe9f3'];

export function coverStyle(cover: string): React.CSSProperties {
  if (cover.startsWith('gradient:')) return { background: GRADIENTS[Number(cover.slice(9))] ?? GRADIENTS[0] };
  if (cover.startsWith('color:')) return { background: cover.slice(6) };
  return {};
}
export const isImageCover = (c: string) => !c.startsWith('gradient:') && !c.startsWith('color:');

export function CoverPicker({ anchor, open, onClose, onPick }: { anchor: HTMLElement | null; open: boolean; onClose: () => void; onPick: (c: string | null) => void }) {
  const [tab, setTab] = useState<'gallery' | 'upload' | 'link'>('gallery');
  const [link, setLink] = useState('');
  const file = useRef<HTMLInputElement>(null);
  return (
    <Popover anchor={anchor} open={open} onClose={onClose} width={480} placement="bottom-end">
      <div className="picker-tabs">
        {(['gallery', 'upload', 'link'] as const).map((t) => (
          <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{t[0].toUpperCase() + t.slice(1)}</button>
        ))}
        <span style={{ flex: 1 }} />
        <button onClick={() => onPick(null)}>Remove</button>
      </div>
      {tab === 'gallery' && (
        <div style={{ padding: 8 }}>
          <div className="menu-heading" style={{ paddingLeft: 0 }}>Gradients</div>
          <div className="cover-grid">{GRADIENTS.map((g, i) => <button key={i} style={{ background: g }} onClick={() => onPick(`gradient:${i}`)} />)}</div>
          <div className="menu-heading" style={{ paddingLeft: 0 }}>Colors</div>
          <div className="cover-grid">{SOLIDS.map((c) => <button key={c} style={{ background: c }} onClick={() => onPick(`color:${c}`)} />)}</div>
        </div>
      )}
      {tab === 'upload' && (
        <div style={{ padding: 16, textAlign: 'center' }}>
          <button className="btn" onClick={() => file.current?.click()}>Upload file</button>
          <div className="faint" style={{ fontSize: 12, marginTop: 8 }}>Images wider than 1500 pixels work best.</div>
          <input ref={file} type="file" accept="image/*" hidden onChange={async (e) => {
            const f = e.target.files?.[0];
            if (f) onPick((await uploadFile(f)).url);
          }} />
        </div>
      )}
      {tab === 'link' && (
        <form style={{ padding: 8, display: 'flex', gap: 8 }} onSubmit={(e) => { e.preventDefault(); if (link) onPick(link); }}>
          <input className="input" autoFocus placeholder="Paste an image link…" value={link} onChange={(e) => setLink(e.target.value)} />
          <button className="btn primary">Submit</button>
        </form>
      )}
    </Popover>
  );
}
