import { Hocuspocus } from '@hocuspocus/server';
import { Redis as RedisExtension } from '@hocuspocus/extension-redis';
import * as Y from 'yjs';
import { newRedis, redisEnabled } from './redis.js';
import { parseCookies, SESSION_COOKIE, userFromSessionToken, userFromApiToken, type AuthUser } from './auth.js';
import { one, q } from './db.js';
import { emit } from './events.js';
import { atLeast, pageLevel } from './perms.js';
import { notify } from './notify.js';

export const FRAGMENT = 'document-store';
const VERSION_INTERVAL_MIN = 10;

interface Ctx {
  user: AuthUser;
}

export interface DocInfo {
  text: string;
  pageLinks: string[];
  userMentions: string[];
  reminders: { date: string; reminder: string }[];
}

/** When a date-mention reminder fires. All-day dates remind at 09:00 server time. */
export function reminderDueAt(date: string, reminder: string): Date | null {
  const timed = date.includes('T');
  const base = timed ? new Date(date) : new Date(`${date}T09:00:00`);
  if (Number.isNaN(base.getTime())) return null;
  const offsets: Record<string, number> = { at: 0, '5m': 5 * 6e4, '15m': 15 * 6e4, '1h': 36e5, '1d': 864e5, '2d': 2 * 864e5, '1w': 7 * 864e5 };
  if (!(reminder in offsets)) return null;
  return new Date(base.getTime() - offsets[reminder]);
}

/** Walks the BlockNote Yjs XML tree, pulling plain text, page links and @-mentions. */
export function inspectDoc(doc: Y.Doc): DocInfo {
  const lines: string[] = [];
  const pageLinks = new Set<string>();
  const users = new Set<string>();
  const reminders = new Map<string, { date: string; reminder: string }>();
  const linkRe = /\/p\/([0-9a-f-]{36})/;
  const walk = (node: Y.XmlElement | Y.XmlText | Y.XmlFragment, buf: string[]) => {
    if (node instanceof Y.XmlText) {
      for (const d of node.toDelta() as any[]) {
        if (typeof d.insert === 'string') buf.push(d.insert);
        const href = d.attributes?.link?.href;
        const m = typeof href === 'string' && href.match(linkRe);
        if (m) pageLinks.add(m[1]);
      }
      return;
    }
    if (node instanceof Y.XmlElement) {
      const name = node.nodeName;
      if (name.toLowerCase() === 'mention') {
        const kind = node.getAttribute('kind');
        const id = node.getAttribute('id');
        const label = node.getAttribute('label');
        if (kind === 'user' && id) users.add(id);
        if (kind === 'page' && id) pageLinks.add(id);
        if (kind === 'date') {
          const date = node.getAttribute('date') ?? '';
          const reminder = node.getAttribute('reminder') ?? '';
          if (date && reminder) reminders.set(`${date}|${reminder}`, { date, reminder });
          buf.push(date);
          return;
        }
        buf.push(kind === 'user' ? `@${label ?? ''}` : (label ?? ''));
        return;
      }
      const lname = name.toLowerCase();
      if (lname === 'inlineequation') {
        buf.push(node.getAttribute('latex') ?? '');
        return;
      }
      if (lname === 'subpage') {
        const id = node.getAttribute('pageId');
        if (id) pageLinks.add(id);
      }
      // Synced copies and embedded databases count as links (powers "Editing in N pages" and backlinks).
      if (lname === 'syncedblock') {
        const id = node.getAttribute('sourceId');
        if (id) pageLinks.add(id);
      }
      if (lname === 'database') {
        const id = node.getAttribute('databaseId');
        if (id) pageLinks.add(id);
      }
      if (lname === 'equation') buf.push(node.getAttribute('latex') ?? '');
      if (lname === 'bookmark') buf.push(`${node.getAttribute('title') ?? ''} ${node.getAttribute('url') ?? ''}`);
      if (name.toLowerCase() === 'blockcontainer') {
        const inner: string[] = [];
        for (const c of node.toArray()) walk(c as any, inner);
        const t = inner.join('').trim();
        if (t) lines.push(t);
        return;
      }
    }
    for (const c of (node as Y.XmlElement).toArray()) walk(c as any, buf);
  };
  walk(doc.getXmlFragment(FRAGMENT), []);
  return { text: lines.join('\n'), pageLinks: [...pageLinks], userMentions: [...users], reminders: [...reminders.values()] };
}

/** Keep the reminders table in step with the date-mention reminders present in a page. */
async function syncReminders(pageId: string, list: DocInfo['reminders'], userId: string | null) {
  const keys = list.map((r) => `${r.date}|${r.reminder}`);
  await q('delete from reminders where page_id = $1 and not (key = any($2::text[]))', [pageId, keys]);
  if (!list.length) return;
  const owner = userId ?? (await one('select coalesce(updated_by, created_by) as u from pages where id = $1', [pageId]))?.u ?? null;
  if (!owner) return;
  for (const r of list) {
    const due = reminderDueAt(r.date, r.reminder);
    if (!due) continue;
    // Reminders added for a time already well past are recorded as fired so they don't spam.
    await q(
      `insert into reminders(page_id, key, user_id, date_value, reminder, due_at, fired_at)
       values ($1,$2,$3,$4,$5,$6, case when $6::timestamptz < now() - interval '5 minutes' then now() end)
       on conflict (page_id, key) do nothing`,
      [pageId, `${r.date}|${r.reminder}`, owner, r.date, r.reminder, due],
    );
  }
}

/** Fires due reminders as inbox notifications. Each reminder is claimed atomically, so it fires once. */
export async function fireDueReminders() {
  const due = await q(
    `update reminders set fired_at = now() where id in (
       select id from reminders where fired_at is null and due_at <= now() order by due_at limit 100 for update skip locked
     ) returning page_id, user_id, date_value, reminder`,
  );
  for (const r of due) if (r.user_id) await notify(r.user_id, 'reminder', null, r.page_id, { date: r.date_value, reminder: r.reminder });
  return due.length;
}

export async function persistDoc(pageId: string, doc: Y.Doc, userId: string | null) {
  const state = Buffer.from(Y.encodeStateAsUpdate(doc));
  const info = inspectDoc(doc);
  const prev = await one<{ text: string; ydoc: Buffer }>('select text, ydoc from page_content where page_id = $1', [pageId]);
  // Safety net: snapshot the previous state before any large deletion so it can be restored from history.
  if (prev && prev.text.length > 80 && info.text.length < prev.text.length / 2) {
    const t = await one('select title from pages where id = $1', [pageId]);
    await q('insert into page_versions(page_id, ydoc, title, created_by) values ($1,$2,$3,$4)', [pageId, prev.ydoc, t?.title ?? '', userId]);
  }
  await q(
    `insert into page_content(page_id, ydoc, text, updated_at) values ($1,$2,$3, now())
     on conflict (page_id) do update set ydoc = excluded.ydoc, text = excluded.text, updated_at = now()`,
    [pageId, state, info.text],
  );
  if (prev?.text !== info.text) {
    await q('update pages set updated_at = now(), updated_by = coalesce($2, updated_by) where id = $1', [pageId, userId]);
  }
  await q('delete from page_links where source_id = $1', [pageId]);
  if (info.pageLinks.length) {
    await q(
      `insert into page_links(source_id, target_id) select $1, id from pages where id = any($2::uuid[]) and id <> $1
       on conflict do nothing`,
      [pageId, info.pageLinks],
    );
  }
  await syncReminders(pageId, info.reminders, userId);
  // Version snapshots: at most one per interval while editing.
  const last = await one(
    `select created_at > now() - interval '${VERSION_INTERVAL_MIN} minutes' as recent from page_versions
     where page_id = $1 order by created_at desc limit 1`,
    [pageId],
  );
  if (!last?.recent && info.text.length) {
    const t = await one('select title from pages where id = $1', [pageId]);
    await q('insert into page_versions(page_id, ydoc, title, created_by) values ($1,$2,$3,$4)', [
      pageId,
      state,
      t?.title ?? '',
      userId,
    ]);
  }
  return info;
}

const mentionCache = new Map<string, Set<string>>();

/** BlockNote expects exactly one root blockGroup. Merge extras (from initial-sync races) into the first. */
function repairRoots(doc: Y.Doc) {
  const frag = doc.getXmlFragment(FRAGMENT);
  if (frag.length <= 1) return;
  doc.transact(() => {
    const groups = frag.toArray() as Y.XmlElement[];
    const isEmpty = (g: Y.XmlElement) => g.length === 1 && !(g.toString().replace(/<[^>]*>/g, '').trim());
    const keep = groups.filter((g) => !isEmpty(g));
    const target = (keep[0] ?? groups[0]) as Y.XmlElement;
    for (const g of keep.slice(1)) target.insert(target.length, g.toArray().map((n) => (n as Y.XmlElement).clone()));
    for (let i = frag.length - 1; i >= 0; i--) if (frag.get(i) !== target) frag.delete(i, 1);
  });
}

export const hocuspocus = new Hocuspocus<Ctx>({
  name: 'atrium',
  debounce: 1500,
  maxDebounce: 10000,
  quiet: true,
  // Multi-instance (ECS): Redis relays document updates + awareness between tasks and takes a
  // distributed lock so only one instance persists a document at a time.
  extensions: redisEnabled() ? [new RedisExtension({ createClient: () => newRedis() as any, prefix: 'atrium:collab' } as any)] : [],

  async onAuthenticate({ token, requestHeaders, documentName, connectionConfig }) {
    const cookies = parseCookies(requestHeaders.get('cookie'));
    let user = await userFromSessionToken(cookies[SESSION_COOKIE]);
    if (!user && token && token !== 'cookie') user = await userFromApiToken(token);
    if (!user) throw new Error('unauthorized');
    const level = await pageLevel(user, documentName);
    if (!atLeast(level, 'view')) throw new Error('forbidden');
    const page = await one('select locked, deleted_at from pages where id = $1', [documentName]);
    if (!atLeast(level, 'edit') || page?.locked || page?.deleted_at) connectionConfig.readOnly = true;
    return { user };
  },

  async onLoadDocument({ documentName, document }) {
    const row = await one<{ ydoc: Buffer }>('select ydoc from page_content where page_id = $1', [documentName]);
    if (row) Y.applyUpdate(document, new Uint8Array(row.ydoc));
    repairRoots(document);
    mentionCache.set(documentName, new Set(inspectDoc(document).userMentions));
    return document;
  },

  async onStoreDocument({ documentName, document, lastContext }) {
    const actor = (lastContext as Ctx | undefined)?.user;
    const info = await persistDoc(documentName, document, actor?.id ?? null);
    const before = mentionCache.get(documentName) ?? new Set();
    const added = info.userMentions.filter((u) => !before.has(u) && u !== actor?.id);
    mentionCache.set(documentName, new Set(info.userMentions));
    for (const uid of added) await notify(uid, 'mention', actor?.id ?? null, documentName, {});
    emit({ type: 'page', id: documentName });
  },

  async afterUnloadDocument({ documentName }) {
    mentionCache.delete(documentName);
  },
});

/** Run a server-side edit against the live (or stored) document so connected clients see it. */
export async function withDoc(pageId: string, fn: (doc: Y.Doc) => void) {
  const conn = await hocuspocus.openDirectConnection(pageId, {} as Ctx);
  try {
    await conn.transact((doc) => fn(doc));
  } finally {
    await conn.disconnect();
  }
}

export async function loadDocSnapshot(pageId: string): Promise<Y.Doc> {
  const live = hocuspocus.documents.get(pageId);
  const doc = new Y.Doc();
  if (live) {
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(live));
    return doc;
  }
  const row = await one<{ ydoc: Buffer }>('select ydoc from page_content where page_id = $1', [pageId]);
  if (row) Y.applyUpdate(doc, new Uint8Array(row.ydoc));
  return doc;
}

/** Replace a document's content with the content of another doc (used by version restore, imports, API writes). */
export async function replaceDocContent(pageId: string, source: Y.Doc) {
  await withDoc(pageId, (doc) => {
    const frag = doc.getXmlFragment(FRAGMENT);
    frag.delete(0, frag.length);
    const src = source.getXmlFragment(FRAGMENT);
    frag.insert(0, src.toArray().map((n) => (n as Y.XmlElement).clone()));
  });
}
