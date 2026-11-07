import { createReactBlockSpec } from '@blocknote/react';
import { useNavigate } from 'react-router-dom';
import { usePage } from '../../lib/hooks';
import { PageIcon } from '../ui';
import { useEditorPage } from './context';

function Breadcrumb() {
  const { pageId } = useEditorPage();
  const { data: page } = usePage(pageId || undefined);
  const nav = useNavigate();
  if (!page) return <div className="breadcrumb-block faint">…</div>;
  return (
    <div className="breadcrumb-block" contentEditable={false}>
      {page.teamspace && (
        <>
          <span className="crumb-static"><span className="emoji">{page.teamspace.icon}</span> {page.teamspace.name}</span>
          <span className="crumb-sep">/</span>
        </>
      )}
      {page.breadcrumbs.map((c, i) => (
        <span key={c.id} style={{ display: 'contents' }}>
          {i > 0 && <span className="crumb-sep">/</span>}
          <a href={`/p/${c.id}`} onClick={(e) => { e.preventDefault(); nav(`/p/${c.id}`); }}>
            <PageIcon icon={c.icon} kind={c.kind} size={15} /> {c.title || 'Untitled'}
          </a>
        </span>
      ))}
    </div>
  );
}

export const breadcrumbBlock = createReactBlockSpec(
  { type: 'breadcrumb', propSchema: {}, content: 'none' },
  { render: () => <Breadcrumb /> },
);
