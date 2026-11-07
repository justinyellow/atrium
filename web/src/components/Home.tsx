import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ChevronsRight, Clock, Plus, Database } from 'lucide-react';
import { get } from '../lib/api';
import { useMe, useTree } from '../lib/hooks';
import { useUi } from '../lib/store';
import { PageIcon, timeAgo } from './ui';
import { coverStyle, isImageCover } from './PagePickers';
import { createPageAndOpen } from './Sidebar';

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Good evening' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

export default function Home() {
  const nav = useNavigate();
  const ui = useUi();
  const { data: me } = useMe();
  const { data: tree } = useTree();
  const { data: recent } = useQuery({ queryKey: ['recent'], queryFn: () => get('/recent') });
  const dbs = tree?.pages.filter((p) => p.kind === 'database') ?? [];
  return (
    <div className="main">
      <div className="topbar">
        {!ui.sidebarOpen && <button className="icon-btn" onClick={() => ui.setSidebarOpen(true)}><ChevronsRight size={18} /></button>}
        <div className="breadcrumbs"><span className="crumb">Home</span></div>
      </div>
      <div className="scroller">
        <div className="home">
          <h1 className="home-greeting">{greeting()}, {me?.name.split(' ')[0]}</h1>
          <div className="home-section-title"><Clock size={14} /> Recently visited</div>
          <div className="home-cards">
            {(recent ?? []).slice(0, 8).map((r: any) => (
              <div key={r.id} className="home-card" onClick={() => nav(`/p/${r.id}`)}>
                <div className="home-card-cover" style={r.cover ? coverStyle(r.cover) : undefined}>
                  {r.cover && isImageCover(r.cover) && <img src={r.cover} alt="" />}
                </div>
                <div className="home-card-icon"><PageIcon icon={r.icon} kind={r.kind} size={26} /></div>
                <div className="home-card-title">{r.title || 'Untitled'}</div>
                <div className="home-card-meta">{timeAgo(r.visited_at)}</div>
              </div>
            ))}
            <div className="home-card new" onClick={() => createPageAndOpen(nav, {})}>
              <Plus size={22} />
              <div>New page</div>
            </div>
          </div>
          {!!dbs.length && (
            <>
              <div className="home-section-title" style={{ marginTop: 32 }}><Database size={14} /> Databases</div>
              <div className="home-list">
                {dbs.slice(0, 10).map((d) => (
                  <div key={d.id} className="home-list-item" onClick={() => nav(`/p/${d.id}`)}>
                    <PageIcon icon={d.icon} kind="database" size={18} /> {d.title || 'Untitled'}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
