import { Fragment, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

/**
 * Small, safe Markdown renderer for AI answers (no HTML passthrough).
 * Supports headings, paragraphs, bullet/numbered/task lists, fenced code, quotes, bold, italic, inline code, links.
 * Links to /p/<id> navigate inside the app.
 */
export function Markdown({ text }: { text: string }) {
  const nav = useNavigate();

  const inline = (s: string, key: string): ReactNode[] => {
    const out: ReactNode[] = [];
    const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\([^)\s]+\))/g;
    let last = 0;
    let m: RegExpExecArray | null;
    let i = 0;
    while ((m = re.exec(s))) {
      if (m.index > last) out.push(s.slice(last, m.index));
      const t = m[0];
      const k = `${key}-${i++}`;
      if (m[1]) out.push(<code key={k}>{t.slice(1, -1)}</code>);
      else if (m[2]) out.push(<strong key={k}>{inline(t.slice(2, -2), k)}</strong>);
      else if (m[3]) out.push(<em key={k}>{inline(t.slice(1, -1), k)}</em>);
      else {
        const lm = t.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/)!;
        const href = lm[2];
        const internal = /^\/p\/[0-9a-f-]{36}/.test(href);
        const safe = internal || /^https?:\/\//.test(href) || href.startsWith('mailto:');
        out.push(
          safe ? (
            <a
              key={k}
              href={href}
              className={internal ? 'ai-md-pagelink' : undefined}
              target={internal ? undefined : '_blank'}
              rel={internal ? undefined : 'noreferrer'}
              onClick={(e) => {
                if (!internal) return;
                e.preventDefault();
                nav(href);
              }}
            >
              {lm[1]}
            </a>
          ) : (
            <span key={k}>{lm[1]}</span>
          ),
        );
      }
      last = m.index + t.length;
    }
    if (last < s.length) out.push(s.slice(last));
    return out;
  };

  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  let n = 0;
  while (i < lines.length) {
    const line = lines[i];
    const key = `b${n++}`;
    if (line.startsWith('```')) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) code.push(lines[i++]);
      i++;
      blocks.push(<pre key={key}><code>{code.join('\n')}</code></pre>);
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const level = Math.min(h[1].length + 2, 6);
      const Tag = `h${level}` as 'h3';
      blocks.push(<Tag key={key}>{inline(h[2], key)}</Tag>);
      i++;
      continue;
    }
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: ReactNode[] = [];
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
        const body = lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, '');
        const task = body.match(/^\[( |x|X)\]\s+(.*)$/);
        items.push(
          <li key={`${key}-${items.length}`} className={task ? 'ai-md-task' : undefined}>
            {task ? <><input type="checkbox" checked={task[1] !== ' '} readOnly /> {inline(task[2], `${key}-${items.length}`)}</> : inline(body, `${key}-${items.length}`)}
          </li>,
        );
        i++;
      }
      blocks.push(ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>);
      continue;
    }
    if (line.startsWith('>')) {
      const q: string[] = [];
      while (i < lines.length && lines[i].startsWith('>')) q.push(lines[i++].replace(/^>\s?/, ''));
      blocks.push(<blockquote key={key}>{inline(q.join(' '), key)}</blockquote>);
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|>|\s*([-*+]|\d+\.)\s)/.test(lines[i])) para.push(lines[i++]);
    blocks.push(<p key={key}>{para.map((p, j) => <Fragment key={j}>{j > 0 && <br />}{inline(p, `${key}-${j}`)}</Fragment>)}</p>);
  }
  return <div className="ai-md">{blocks}</div>;
}
