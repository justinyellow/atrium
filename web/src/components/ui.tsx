import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { FileText, Database as DbIcon } from 'lucide-react';

/** Page icon: emoji, uploaded image URL, or a default glyph. */
export function PageIcon({ icon, kind, size = 18 }: { icon: string | null | undefined; kind?: string; size?: number }) {
  if (icon && (icon.startsWith('/') || icon.startsWith('http')))
    return <img src={icon} alt="" style={{ width: size, height: size, borderRadius: 3, objectFit: 'cover' }} />;
  if (icon) return <span className="emoji" style={{ fontSize: size * 0.95, lineHeight: 1 }}>{icon}</span>;
  const Ico = kind === 'database' ? DbIcon : FileText;
  return <Ico size={size * 0.95} strokeWidth={1.6} className="default-icon" />;
}

const AVATAR_COLORS = ['#e16259', '#d9730d', '#dfab01', '#0f7b6c', '#0b6e99', '#6940a5', '#ad1a72', '#64473a'];
export function Avatar({ user, size = 22 }: { user?: { name?: string; avatar_url?: string | null; id?: string } | null; size?: number }) {
  if (!user) return null;
  if (user.avatar_url) return <img className="avatar" src={user.avatar_url} style={{ width: size, height: size }} alt={user.name} />;
  const name = user.name ?? '?';
  const h = [...(user.id ?? name)].reduce((a, c) => a + c.charCodeAt(0), 0);
  return (
    <span className="avatar" title={name} style={{ width: size, height: size, fontSize: size * 0.5, background: AVATAR_COLORS[h % AVATAR_COLORS.length] }}>
      {name.trim()[0]?.toUpperCase() ?? '?'}
    </span>
  );
}

/** Anchored floating layer that closes on outside click / Escape. */
export function Popover({
  anchor, open, onClose, children, placement = 'bottom-start', width, className, offset = 4,
}: {
  anchor: HTMLElement | null | { x: number; y: number };
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  placement?: 'bottom-start' | 'bottom-end' | 'right-start' | 'top-start';
  width?: number;
  className?: string;
  offset?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<CSSProperties>({ visibility: 'hidden' });
  useLayoutEffect(() => {
    if (!open || !anchor) return;
    const r = 'getBoundingClientRect' in anchor ? anchor.getBoundingClientRect() : new DOMRect(anchor.x, anchor.y, 0, 0);
    const el = ref.current;
    const w = width ?? el?.offsetWidth ?? 240;
    const h = el?.offsetHeight ?? 200;
    let left = placement === 'bottom-end' ? r.right - w : placement === 'right-start' ? r.right + offset : r.left;
    let top = placement === 'right-start' ? r.top : placement === 'top-start' ? r.top - h - offset : r.bottom + offset;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    if (top + h > window.innerHeight - 8) top = Math.max(8, (placement === 'right-start' ? window.innerHeight : r.top) - h - offset);
    setPos({ left, top, width });
  }, [open, anchor, placement, width, offset, children]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t)) return;
      if (anchor && 'contains' in anchor && anchor.contains(t)) return;
      // Ignore clicks inside nested popovers rendered later in the DOM.
      if ((t as HTMLElement).closest?.('.popover') && (t as HTMLElement).closest('.popover') !== ref.current) {
        const all = [...document.querySelectorAll('.popover')];
        if (all.indexOf((t as HTMLElement).closest('.popover')!) > all.indexOf(ref.current!)) return;
      }
      onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    const id = setTimeout(() => document.addEventListener('mousedown', onDown), 0);
    document.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(id);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose, anchor]);
  if (!open) return null;
  return createPortal(
    <div ref={ref} className={`popover ${className ?? ''}`} style={{ position: 'fixed', ...pos }} onMouseDown={(e) => e.stopPropagation()}>
      {children}
    </div>,
    document.body,
  );
}

export function MenuItem({
  icon, children, onClick, danger, right, active, disabled,
}: { icon?: ReactNode; children: ReactNode; onClick?: (e: React.MouseEvent) => void; danger?: boolean; right?: ReactNode; active?: boolean; disabled?: boolean }) {
  return (
    <button className={`menu-item ${danger ? 'danger' : ''} ${active ? 'active' : ''}`} onClick={onClick} disabled={disabled}>
      {icon && <span className="menu-icon">{icon}</span>}
      <span className="menu-label">{children}</span>
      {right && <span className="menu-right">{right}</span>}
    </button>
  );
}

export function Modal({ open, onClose, children, width = 720, className }: { open: boolean; onClose: () => void; children: ReactNode; width?: number | string; className?: string }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className={`modal ${className ?? ''}`} style={{ width }} onMouseDown={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>,
    document.body,
  );
}

export function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return <button className={`toggle ${checked ? 'on' : ''}`} onClick={() => onChange(!checked)} role="switch" aria-checked={checked}><span /></button>;
}

let toastFn: ((msg: string) => void) | null = null;
export function toast(msg: string) {
  toastFn?.(msg);
}
export function Toaster() {
  const [msgs, setMsgs] = useState<{ id: number; msg: string }[]>([]);
  useEffect(() => {
    toastFn = (msg) => {
      const id = Math.random();
      setMsgs((m) => [...m, { id, msg }]);
      setTimeout(() => setMsgs((m) => m.filter((x) => x.id !== id)), 3500);
    };
    return () => {
      toastFn = null;
    };
  }, []);
  return createPortal(
    <div className="toaster">{msgs.map((m) => <div key={m.id} className="toast">{m.msg}</div>)}</div>,
    document.body,
  );
}

export function timeAgo(iso: string) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'Just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
