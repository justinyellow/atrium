import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import type pg from 'pg';
import { q, one, tx } from './db.js';
import { FRAGMENT } from './collab.js';

export const PAGE_COLS = `id, workspace_id, parent_id, teamspace_id, owner_id, kind, title, icon, cover, cover_position,
  props, full_width, small_text, locked, is_template, position, created_by, updated_by, created_at, updated_at,
  deleted_at, public_slug, auto_id`;

export async function nextPosition(parentId: string | null, teamspaceId: string | null, ownerId: string | null) {
  const r = parentId
    ? await one('select coalesce(max(position), 0) + 1 as p from pages where parent_id = $1', [parentId])
    : teamspaceId
      ? await one('select coalesce(max(position), 0) + 1 as p from pages where parent_id is null and teamspace_id = $1', [teamspaceId])
      : await one('select coalesce(max(position), 0) + 1 as p from pages where parent_id is null and teamspace_id is null and owner_id = $1', [ownerId]);
  return Number(r.p);
}

export async function descendants(pageId: string, includeDeleted = true): Promise<string[]> {
  const rows = await q<{ id: string }>(
    `with recursive d as (select id from pages where id = $1
       union all select p.id from pages p join d on p.parent_id = d.id ${includeDeleted ? '' : 'where p.deleted_at is null'})
     select id from d`,
    [pageId],
  );
  return rows.map((r) => r.id);
}

export async function isDescendant(candidate: string, ancestor: string) {
  return (await descendants(ancestor)).includes(candidate);
}

export async function breadcrumbs(pageId: string) {
  return q(
    `with recursive c as (select id, parent_id, title, icon, kind, 0 d from pages where id = $1
       union all select p.id, p.parent_id, p.title, p.icon, p.kind, c.d + 1 from pages p join c on p.id = c.parent_id where c.d < 100)
     select id, title, icon, kind from c order by d desc`,
    [pageId],
  );
}

/**
 * Rewrites references inside a duplicated Yjs doc: sub-page blocks and inline databases point at
 * their copies, and linked-database blocks get fresh block ids (returned so their views can be copied).
 */
function remapDoc(state: Buffer, idMap: Map<string, string>): { buf: Buffer; linked: { oldBlock: string; newBlock: string; databaseId: string }[] } {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, new Uint8Array(state));
  const linked: { oldBlock: string; newBlock: string; databaseId: string }[] = [];
  const walk = (n: any, parent: any) => {
    if (n instanceof Y.XmlElement) {
      const name = n.nodeName.toLowerCase();
      if (name === 'subpage') {
        const old = n.getAttribute('pageId');
        if (old && idMap.has(old)) n.setAttribute('pageId', idMap.get(old)!);
      }
      if (name === 'database') {
        const dbId = n.getAttribute('databaseId') as string | undefined;
        if (dbId && idMap.has(dbId)) n.setAttribute('databaseId', idMap.get(dbId)!);
        const isLinked = String(n.getAttribute('linked' as any)) === 'true';
        if (isLinked && dbId && parent instanceof Y.XmlElement) {
          const oldBlock = parent.getAttribute('id') as string | undefined;
          if (oldBlock) {
            const newBlock = randomUUID();
            parent.setAttribute('id', newBlock);
            linked.push({ oldBlock, newBlock, databaseId: dbId });
          }
        }
      }
      n.toArray().forEach((c: any) => walk(c, n));
    }
  };
  doc.getXmlFragment(FRAGMENT).toArray().forEach((c: any) => walk(c, null));
  return { buf: Buffer.from(Y.encodeStateAsUpdate(doc)), linked };
}

/** Deep-copies a page subtree (content, databases, views, rows). Returns the new root id. */
export async function duplicateTree(
  rootId: string,
  userId: string,
  overrides: { parent_id?: string | null; title?: string; position?: number; is_template?: boolean } = {},
) {
  const ids = await descendants(rootId, false);
  return tx(async (c: pg.PoolClient) => {
    const idMap = new Map<string, string>();
    for (const id of ids) idMap.set(id, (await c.query('select gen_random_uuid() as id')).rows[0].id);
    const pages = (await c.query(`select ${PAGE_COLS} from pages where id = any($1::uuid[])`, [ids])).rows;
    // insert parents before children
    pages.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
    for (const p of pages) {
      const isRoot = p.id === rootId;
      await c.query(
        `insert into pages(id, workspace_id, parent_id, teamspace_id, owner_id, kind, title, icon, cover, cover_position,
           props, full_width, small_text, locked, is_template, position, created_by, updated_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$17)`,
        [
          idMap.get(p.id),
          p.workspace_id,
          isRoot ? (overrides.parent_id !== undefined ? overrides.parent_id : p.parent_id) : idMap.get(p.parent_id),
          p.teamspace_id,
          p.owner_id,
          p.kind,
          isRoot && overrides.title !== undefined ? overrides.title : p.title,
          p.icon,
          p.cover,
          p.cover_position,
          p.props,
          p.full_width,
          p.small_text,
          false,
          isRoot ? (overrides.is_template ?? false) : p.is_template,
          isRoot && overrides.position !== undefined ? overrides.position : p.position,
          userId,
        ],
      );
    }
    const contents = (await c.query('select page_id, ydoc, text from page_content where page_id = any($1::uuid[])', [ids])).rows;
    for (const ct of contents) {
      const { buf, linked } = remapDoc(ct.ydoc, idMap);
      await c.query('insert into page_content(page_id, ydoc, text) values ($1,$2,$3)', [idMap.get(ct.page_id), buf, ct.text]);
      // Linked database blocks got new ids: give each copy its own views.
      for (const l of linked) {
        await c.query(
          `insert into database_views(database_id, name, type, config, position, block_id)
           select $1, name, type, config, position, $2 from database_views where database_id = $3 and block_id = $4`,
          [idMap.get(l.databaseId) ?? l.databaseId, l.newBlock, l.databaseId, l.oldBlock],
        );
      }
    }
    const dbs = (await c.query('select page_id, schema from databases where page_id = any($1::uuid[])', [ids])).rows;
    for (const d of dbs) {
      await c.query('insert into databases(page_id, schema) values ($1,$2)', [idMap.get(d.page_id), JSON.stringify(d.schema)]);
      const views = (await c.query('select name, type, config, position from database_views where database_id = $1 and block_id is null', [d.page_id])).rows;
      for (const v of views) {
        let config = JSON.stringify(v.config);
        for (const [o, n] of idMap) config = config.replaceAll(o, n);
        await c.query('insert into database_views(database_id, name, type, config, position) values ($1,$2,$3,$4,$5)', [
          idMap.get(d.page_id),
          v.name,
          v.type,
          config,
          v.position,
        ]);
      }
    }
    return idMap.get(rootId)!;
  });
}
