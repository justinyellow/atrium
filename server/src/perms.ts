import type { AuthUser } from './auth.js';
import { fail } from './auth.js';
import { q } from './db.js';

export type Level = 'none' | 'view' | 'comment' | 'edit' | 'full';
export const RANK: Record<Level, number> = { none: 0, view: 1, comment: 2, edit: 3, full: 4 };
export const maxLevel = (a: Level, b: Level): Level => (RANK[a] >= RANK[b] ? a : b);
export const atLeast = (l: Level, need: Level) => RANK[l] >= RANK[need];

interface ChainRow {
  id: string;
  parent_id: string | null;
  teamspace_id: string | null;
  owner_id: string | null;
  deleted_at: string | null;
}

export async function chain(pageId: string): Promise<ChainRow[]> {
  return q<ChainRow>(
    `with recursive c as (
       select id, parent_id, teamspace_id, owner_id, deleted_at, 0 as depth from pages where id = $1
       union all
       select p.id, p.parent_id, p.teamspace_id, p.owner_id, p.deleted_at, c.depth + 1
       from pages p join c on p.id = c.parent_id where c.depth < 100
     ) select * from c order by depth`,
    [pageId],
  );
}

async function teamspaceLevel(user: AuthUser, teamspaceId: string): Promise<Level> {
  if (user.role === 'guest') return 'none';
  const [t] = await q(
    `select t.is_default, t.default_level, m.role as member_role
     from teamspaces t left join teamspace_members m on m.teamspace_id = t.id and m.user_id = $2
     where t.id = $1`,
    [teamspaceId, user.id],
  );
  if (!t) return 'none';
  if (t.member_role === 'owner') return 'full';
  if (t.member_role || t.is_default) return t.default_level as Level;
  return 'none';
}

function grantMatches(user: AuthUser) {
  return {
    sql: `((principal_type = 'user' and principal_id = $2)
        or (principal_type = 'group' and principal_id = any($3::uuid[]))
        or (principal_type = 'workspace' and $4))`,
    params: [user.id, user.groupIds, user.role !== 'guest'],
  };
}

export async function pageLevel(user: AuthUser, pageId: string): Promise<Level> {
  const c = await chain(pageId);
  if (!c.length) return 'none';
  const root = c[c.length - 1];
  let level: Level = 'none';
  if (root.teamspace_id) level = await teamspaceLevel(user, root.teamspace_id);
  else if (root.owner_id === user.id && user.role !== 'guest') level = 'full';
  const g = grantMatches(user);
  const grants = await q<{ level: Level }>(
    `select level from page_permissions where page_id = any($1::uuid[]) and ${g.sql}`,
    [c.map((r) => r.id), ...g.params],
  );
  for (const gr of grants) level = maxLevel(level, gr.level);
  return level;
}

export async function publicLevel(pageId: string): Promise<Level> {
  const c = await chain(pageId);
  if (!c.length || c[0].deleted_at) return 'none';
  const r = await q(`select 1 from page_permissions where page_id = any($1::uuid[]) and principal_type = 'public'
       and (expires_at is null or expires_at > now()) and password_hash is null`, [
    c.map((x) => x.id),
  ]);
  return r.length ? 'view' : 'none';
}

export async function assertPage(user: AuthUser, pageId: string, need: Level): Promise<Level> {
  const l = await pageLevel(user, pageId);
  if (!atLeast(l, need)) fail(l === 'none' ? 404 : 403, l === 'none' ? 'Page not found' : 'Insufficient permission');
  return l;
}

export interface TreePage {
  id: string;
  parent_id: string | null;
  teamspace_id: string | null;
  owner_id: string | null;
  kind: string;
  title: string;
  icon: string | null;
  position: number;
  level?: Level;
}

/**
 * Computes effective access for every non-deleted page in the workspace in one pass. Rows are left out
 * unless they hold sub-pages, so those pages nest under their row instead of becoming roots.
 */
export async function visibleTree(user: AuthUser): Promise<TreePage[]> {
  const pages = await q<TreePage>(
    `select id, parent_id, teamspace_id, owner_id, kind, title, icon, position
     from pages p where workspace_id = $1 and deleted_at is null and not is_template
       and (kind in ('page', 'database') or (kind = 'row' and exists (
         select 1 from pages c where c.parent_id = p.id and c.kind in ('page', 'database') and c.deleted_at is null)))
     order by position, created_at`,
    [user.workspaceId],
  );
  const g = grantMatches(user);
  const grants = await q<{ page_id: string; level: Level }>(
    `select pp.page_id, pp.level from page_permissions pp join pages p on p.id = pp.page_id
     where p.workspace_id = $1 and ${g.sql.replaceAll('principal', 'pp.principal')}`,
    [user.workspaceId, ...g.params],
  );
  const grantBy = new Map<string, Level>();
  for (const gr of grants) grantBy.set(gr.page_id, maxLevel(grantBy.get(gr.page_id) ?? 'none', gr.level));
  const tsLevels = new Map<string, Level>();
  const tsIds = [...new Set(pages.map((p) => p.teamspace_id).filter(Boolean))] as string[];
  for (const id of tsIds) tsLevels.set(id, await teamspaceLevel(user, id));

  const children = new Map<string | null, TreePage[]>();
  const byId = new Map(pages.map((p) => [p.id, p]));
  for (const p of pages) {
    const key = p.parent_id && byId.has(p.parent_id) ? p.parent_id : null;
    if (!children.has(key)) children.set(key, []);
    children.get(key)!.push(p);
  }
  const out: TreePage[] = [];
  const walk = (p: TreePage, inherited: Level) => {
    let level = inherited;
    if (!p.parent_id || !byId.has(p.parent_id)) {
      if (p.teamspace_id) level = tsLevels.get(p.teamspace_id) ?? 'none';
      else if (p.owner_id === user.id && user.role !== 'guest') level = 'full';
    }
    level = maxLevel(level, grantBy.get(p.id) ?? 'none');
    p.level = level;
    if (level !== 'none') out.push(p);
    for (const c of children.get(p.id) ?? []) walk(c, level);
  };
  for (const r of children.get(null) ?? []) walk(r, 'none');
  return out;
}
