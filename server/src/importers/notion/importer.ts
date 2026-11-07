/**
 * Notion → Atrium importer.
 *
 * 1. Discover: walk the pages/databases the integration can see (or the chosen roots), fetching
 *    page metadata, full block trees, data-source schemas, rows, views, templates.
 * 2. People: match Notion users to Atrium users by email (optionally create guests).
 * 3. Skeleton: create/update every page, database and row (so links and relations can resolve).
 * 4. Schemas, content, row values, views, comments; restore original authors and timestamps.
 *
 * Every Notion object is recorded in import_mappings, so re-running updates changed items and
 * skips unchanged ones instead of duplicating. Dry runs stop after discovery.
 */
import { randomBytes } from 'node:crypto';
import * as Y from 'yjs';
import type { AuthUser } from '../../auth.js';
import { hashPassword } from '../../auth.js';
import { one, q } from '../../db.js';
import { emit } from '../../events.js';
import { blocksToDoc } from '../../markdown.js';
import { richToBlocks } from '../../richmd/index.js';
import { hocuspocus, persistDoc, replaceDocContent } from '../../collab.js';
import { importFileFromUrl } from '../../files/fromUrl.js';
import { NotionClient, NotionApiError, mapLimit, normalizeNotionId, type FetchLike } from './client.js';
import { convertBlocks, convertRowProps, convertSchema, convertView, iconValue, plain, richText, type ConvertCtx } from './convert.js';

export type PeopleMode = 'guests' | 'text';

export interface ImportOptions {
  token: string;
  rootIds?: string[];
  targetTeamspaceId: string;
  peopleMode: PeopleMode;
  dryRun?: boolean;
  /** Re-import content even when Notion says it hasn't changed. */
  force?: boolean;
  /** Sampling caps for trial imports (reported when hit). */
  maxRowsPerSource?: number;
  maxItems?: number;
  /** Notion teamspaces → Atrium teamspaces. Roots listed here (and everything under them) go to that teamspace. */
  teamspaces?: TeamspaceSpec[];
  /** Private roots (kind 'private' in the map): 'owner' (default) imports them into the owner's Private section, 'skip' leaves them out. */
  privatePages?: 'owner' | 'skip';
  /** 'auto' (default): whole-page Markdown endpoint (1 request/page), block tree when needed. 'blocks': always block tree. */
  contentMode?: 'auto' | 'blocks';
  /** Fetch comments on individual blocks (one request per block with text — much slower). Forces block mode. */
  includeInlineComments?: boolean;
  /** Also import pages that imported pages link to or mention (0 = off, max 2 hops). */
  followLinks?: number;
  /** Parallel workers (the client's rate limiter still caps requests/second). */
  concurrency?: number;
  /** Dry run that also converts content to collect lossiness statistics (no writes). */
  census?: boolean;
}

export interface TeamspaceSpec {
  name: string;
  /** 'private': the roots are someone's private Notion pages — they go to that person's Private section, never a shared teamspace. */
  kind?: 'teamspace' | 'private';
  /** Owner of private roots (matched by email; an account is created if missing). */
  ownerEmail?: string | null;
  icon?: string | null;
  notionTeamspaceId?: string | null;
  /** Notion page/database ids or URLs whose trees belong to this teamspace. */
  rootIds: string[];
  access?: 'everyone' | 'members';
  /** Emails of people to add as members (people who don't have Atrium accounts are reported). */
  members?: string[];
}

export interface ImportDeps {
  fetchImpl?: FetchLike;
  fileImporter?: typeof importFileFromUrl;
  minIntervalMs?: number;
  burst?: number;
}

type Kind = 'page' | 'database' | 'row' | 'template';

interface Item {
  kind: Kind;
  notionId: string;
  raw: any; // page or database object
  parent: string | null; // Notion id of the Atrium parent (page, or database for rows)
  dataSourceId?: string; // rows/templates: their data source; databases: primary data source
  title: string;
  order: number;
  inline?: boolean;
  /** Notion-flavored Markdown of the page body (when fetched via the Markdown endpoint). */
  md?: string;
  /** Inline (block-level) discussions: Notion block id → comments. */
  inlineComments?: Map<string, any[]>;
  /** Hops from an explicitly imported page (follow-links). */
  depth?: number;
}

type QueueEntry = { kind: 'page' | 'database' | 'unknown'; id: string; parent: string | null; inline?: boolean; pos?: number; depth?: number };

const NOTION_ID_RE = /([0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12})/i;
const notionHost = (url: string) => /^(https?:\/\/)?([\w-]+\.)?notion\.(so|site|com)\//i.test(url) || /^\{\{/.test(url);
/** Notion page/database id referenced by a Notion URL (or null). */
export function notionIdFromUrl(url: string): string | null {
  if (!url || !notionHost(url)) return null;
  // Ids end a path segment ("Title-<32 hex>" or a dashed UUID); anchoring at the end stops hex letters in
  // the title ("Delta-…", "Data-…") from shifting the match.
  for (const seg of url.split(/[?#]/)[0].split('/').reverse()) {
    const m = seg.replace(/-/g, '').match(/([0-9a-f]{32})$/i);
    if (m) return normalizeNotionId(m[1]);
  }
  return null;
}

interface Warning { kind: string; message: string; notionId?: string; page?: string }

const MAX_WARNINGS = 2000;

export class NotionImport {
  client: NotionClient;
  items = new Map<string, Item>();
  order: string[] = [];
  children = new Map<string, any[]>();
  dataSources = new Map<string, { id: string; databaseId: string; raw: any; rows: any[]; templates: any[] }>();
  dbViews = new Map<string, any[]>(); // Notion database id → views
  /** Linked database views: Notion container id → its source data source and its own views. */
  linked = new Map<string, { sourceDsId: string; views: any[]; parent: string | null }>();
  notionUsers = new Map<string, any>();
  userMap = new Map<string, { id: string; name: string }>();
  atrium = new Map<string, { id: string; title: string }>(); // Notion id (page/db/data source) → Atrium page
  existing = new Map<string, { atrium_id: string; source_last_edited: string | null }>();
  warnings: Warning[] = [];
  warningCounts: Record<string, number> = {};
  counts: Record<string, any> = {
    pages: { created: 0, updated: 0, skipped: 0 },
    databases: { created: 0, updated: 0, skipped: 0 },
    rows: { created: 0, updated: 0, skipped: 0 },
    templates: 0, views: 0, comments: 0, blocks: 0,
    files: { rehosted: 0, reused: 0, failed: 0, external: 0 },
    people: { matched: 0, created: 0, unmatched: 0 },
  };
  roots: { id: string; title: string; kind: string; teamspaceId?: string; ownerId?: string }[] = [];
  /** Notion ids referenced (links/mentions) by imported content but not imported themselves. */
  unresolved = new Map<string, Set<string>>(); // target Notion id → source Notion ids
  /** Pages whose parent is a block (inside a toggle/column/…): resolved to their real page after the main walk. */
  blockParented: { id: string; blockId: string }[] = [];
  /** Notion root id → Atrium teamspace id (from opts.teamspaces). */
  rootTeamspace = new Map<string, string>();
  /** Notion root id → owner user id, for private roots (teamspace_id null). */
  rootOwner = new Map<string, string>();
  privateOwners: { email: string; id: string; created: boolean; roots: number }[] = [];
  teamspaceIds: { name: string; id: string; created: boolean }[] = [];
  census: Record<string, Record<string, number>> = {};
  private queued = new Set<string>();
  private skipPrivate = new Set<string>();
  touched = new Set<string>(); // Notion ids whose content/props were (re)written this run
  private fileCache = new Map<string, string>();
  private syncedDone = new Map<string, string>();
  private currentPage: string | null = null;
  cancelled = false;
  private abort = new AbortController();

  constructor(
    public opts: ImportOptions,
    public admin: AuthUser,
    public deps: ImportDeps = {},
    public onProgress: (phase: string, done: number, total: number) => void = () => {},
  ) {
    this.client = new NotionClient({ token: opts.token, fetchImpl: deps.fetchImpl, minIntervalMs: deps.minIntervalMs, burst: deps.burst, signal: this.abort.signal });
  }

  cancel() {
    this.cancelled = true;
    this.abort.abort();
  }

  private check() {
    if (this.cancelled) throw new NotionApiError(0, 'cancelled', 'Import cancelled');
  }

  warn = (kind: string, message: string, notionId?: string) => {
    this.warningCounts[kind] = (this.warningCounts[kind] ?? 0) + 1;
    if (this.warnings.length < MAX_WARNINGS) {
      const page = this.currentPage ? this.items.get(this.currentPage)?.title : undefined;
      this.warnings.push({ kind, message, ...(notionId ? { notionId } : {}), ...(page !== undefined ? { page } : {}) });
    }
  };

  // ---------------------------------------------------------------- discovery

  /** Fetches a block's children recursively (not into child pages/databases, which are separate items). */
  private async fetchTree(blockId: string, depth = 0): Promise<any[]> {
    this.check();
    const blocks = await this.client.blockChildren(blockId);
    this.children.set(blockId, blocks);
    this.counts.blocks += blocks.length;
    if (depth > 40) return blocks;
    for (const b of blocks) {
      if (b.has_children && b.type !== 'child_page' && b.type !== 'child_database') await this.fetchTree(b.id, depth + 1);
    }
    return blocks;
  }

  /** child_page / child_database blocks anywhere in a fetched tree, in document order. */
  private nestedChildren(blockId: string): any[] {
    const out: any[] = [];
    const walk = (id: string) => {
      for (const b of this.children.get(id) ?? []) {
        if (b.type === 'child_page' || b.type === 'child_database') out.push(b);
        else if (b.has_children) walk(b.id);
      }
    };
    walk(blockId);
    return out;
  }

  private pageTitle(page: any) {
    const t = Object.values(page.properties ?? {}).find((p: any) => p.type === 'title') as any;
    return plain(t?.title);
  }

  private tally(group: string, key: string, n = 1) {
    const g = (this.census[group] ??= {});
    g[key] = (g[key] ?? 0) + n;
  }

  private useMarkdown() {
    return (this.opts.contentMode ?? 'auto') !== 'blocks' && !this.opts.includeInlineComments;
  }

  /** Records a Notion page/database that imported content links to (for follow-links and relinking). */
  private noteRef(targetId: string | null, sourceId: string) {
    if (!targetId || targetId === sourceId) return;
    if (!this.unresolved.has(targetId)) this.unresolved.set(targetId, new Set());
    this.unresolved.get(targetId)!.add(sourceId);
  }

  /** Child pages/databases referenced by a page's Markdown, in document order. */
  private childrenFromMarkdown(md: string, ownerId: string): { kind: 'page' | 'database'; id: string; inline: boolean }[] {
    const out: { kind: 'page' | 'database'; id: string; inline: boolean }[] = [];
    const re = /<(page|database)\b([^>]*)>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(md))) {
      const url = m[2].match(/\burl="([^"]+)"/)?.[1] ?? '';
      const id = notionIdFromUrl(url) ?? (url ? normalizeNotionId(url) : null);
      if (!id || id === ownerId) continue;
      out.push({ kind: m[1].toLowerCase() === 'page' ? 'page' : 'database', id, inline: m[1].toLowerCase() === 'database' && !/\binline="false"/.test(m[2]) });
    }
    // Every other Notion link/mention: candidates for follow-links / relinking.
    for (const u of md.matchAll(/(?:url|href)="([^"]+)"|\]\(([^)\s]+)\)/g)) this.noteRef(notionIdFromUrl(u[1] ?? u[2] ?? ''), ownerId);
    return out;
  }

  /** Page/database ids mentioned or linked in a fetched block tree (follow-links / relinking). */
  private refsFromBlocks(rootId: string) {
    const walk = (id: string) => {
      for (const b of this.children.get(id) ?? []) {
        const d = b[b.type] ?? {};
        for (const t of d.rich_text ?? []) {
          const m = t.mention;
          const nid = m?.page?.id ?? m?.database?.id ?? m?.data_source?.id ?? notionIdFromUrl(t.href ?? t.text?.link?.url ?? '');
          if (nid) this.noteRef(nid, rootId);
        }
        if (b.type === 'link_to_page') this.noteRef(d.page_id ?? d.database_id ?? null, rootId);
        if (b.has_children && b.type !== 'child_page' && b.type !== 'child_database') walk(b.id);
      }
    };
    walk(rootId);
  }

  /**
   * Loads a page's body: one Markdown request when possible, the block tree otherwise. Returns its child
   * pages/databases so discovery can recurse.
   */
  private async fetchContent(item: Item): Promise<{ kind: 'page' | 'database'; id: string; inline: boolean }[]> {
    if (this.useMarkdown()) {
      try {
        const r = await this.client.pageMarkdown(item.notionId);
        const md = r.markdown ?? '';
        const reason = r.truncated ? 'truncated' : r.unknown_block_ids?.length ? 'unknown_blocks' : /<synced[-_]block(?:[-_]reference)?(?=[\s>/])/i.test(md) ? 'synced_block' : /<unknown\b/i.test(md) ? 'unknown_tag' : null;
        if (!reason) {
          item.md = md;
          this.counts.markdownPages = (this.counts.markdownPages ?? 0) + 1;
          return this.childrenFromMarkdown(md, item.notionId);
        }
        this.counts.blockFallbacks = (this.counts.blockFallbacks ?? 0) + 1;
        this.tally('fallback', reason);
      } catch (e: any) {
        if (!(e instanceof NotionApiError) || ![400, 404, 501].includes(e.status)) throw e;
        this.tally('fallback', `markdown_${e.status}`);
      }
    }
    await this.fetchTree(item.notionId);
    this.refsFromBlocks(item.notionId);
    if (this.opts.includeInlineComments) await this.fetchInlineComments(item);
    return this.nestedChildren(item.notionId).map((c) => ({ kind: c.type === 'child_page' ? 'page' : 'database', id: c.id, inline: c.type === 'child_database' }));
  }

  /** Comments attached to blocks (not the page itself). One request per block that has text. */
  private async fetchInlineComments(item: Item) {
    const blocks: any[] = [];
    const walk = (id: string) => {
      for (const b of this.children.get(id) ?? []) {
        if ((b[b.type]?.rich_text ?? []).length) blocks.push(b);
        if (b.has_children && b.type !== 'child_page' && b.type !== 'child_database') walk(b.id);
      }
    };
    walk(item.notionId);
    const found = new Map<string, any[]>();
    await mapLimit(blocks, this.opts.concurrency ?? 4, async (b) => {
      try {
        const cs = await this.client.comments(b.id);
        if (cs.length) found.set(b.id, cs);
      } catch (e: any) {
        if (e instanceof NotionApiError && (e.status === 403 || e.status === 401)) throw e;
      }
    });
    if (found.size) item.inlineComments = found;
  }

  async discover() {
    this.onProgress('discovering', 0, 0);
    this.skipPrivate = this.privateRootIds();
    const queue: QueueEntry[] = [];
    const push = (e: QueueEntry) => {
      if (this.queued.has(e.id)) return;
      this.queued.add(e.id);
      queue.push(e);
    };
    if (this.opts.rootIds?.length) {
      this.opts.rootIds.forEach((r, i) => {
        const id = normalizeNotionId(r);
        if (!id) this.warn('root', `Not a Notion page or database id/URL: ${r}`);
        else push({ kind: 'unknown', id, parent: null, pos: i, depth: 0 });
      });
    } else {
      const [pages, sources] = await Promise.all([this.client.search('page'), this.client.search('data_source')]);
      const visible = new Set<string>([...pages.map((p: any) => p.id), ...sources.map((s: any) => s.parent?.database_id).filter(Boolean)]);
      let pos = 0;
      for (const p of pages) {
        const par = p.parent ?? {};
        if (par.type === 'data_source_id' || par.type === 'database_id') continue; // rows: imported with their database
        if (p.archived || p.is_archived || p.in_trash) continue;
        if (par.type === 'block_id') this.blockParented.push({ id: p.id, blockId: par.block_id });
        else if (par.type === 'workspace' || (par.type === 'page_id' && !visible.has(par.page_id))) push({ kind: 'page', id: p.id, parent: null, pos: pos++, depth: 0 });
      }
      const seenDb = new Set<string>();
      for (const s of sources) {
        const dbId = s.parent?.database_id;
        if (!dbId || seenDb.has(dbId) || s.in_trash || s.is_archived) continue;
        seenDb.add(dbId);
        const dpar = s.database_parent ?? {};
        if (dpar.type === 'block_id') this.blockParented.push({ id: dbId, blockId: dpar.block_id });
        else if (dpar.type === 'workspace' || !dpar.page_id || !visible.has(dpar.page_id)) push({ kind: 'database', id: dbId, parent: null, pos: pos++, depth: 0 });
      }
    }
    await this.drain(queue, push);

    // Pages/databases nested inside blocks of another page are found while walking that page. Any left over
    // belong to pages the walk didn't reach: climb the block chain to the owning page and attach them there.
    const leftovers = this.blockParented.filter((b) => !this.queued.has(b.id));
    if (leftovers.length) {
      await mapLimit(leftovers, this.opts.concurrency ?? 4, async (l) => {
        const owner = await this.owningPage(l.blockId).catch(() => null);
        const parent = owner && this.items.has(owner) ? owner : null;
        push({ kind: 'unknown', id: l.id, parent, depth: 0 });
      });
      await this.drain(queue, push);
    }

    // Follow links: pages that imported content links to, up to N hops.
    const maxDepth = Math.max(0, Math.min(2, this.opts.followLinks ?? 0));
    for (let hop = 1; hop <= maxDepth; hop++) {
      const targets = [...this.unresolved.keys()].filter((id) => !this.items.has(id) && !this.queued.has(id));
      if (!targets.length) break;
      for (const id of targets) push({ kind: 'unknown', id, parent: null, depth: hop });
      await this.drain(queue, push);
    }
    for (const id of [...this.unresolved.keys()]) if (this.items.has(id)) this.unresolved.delete(id);
  }

  /** Walks a block's parents up to the page that contains it. */
  private async owningPage(blockId: string): Promise<string | null> {
    let id = blockId;
    for (let i = 0; i < 20; i++) {
      const b = await this.client.request('GET', `/blocks/${id}`);
      const par = b.parent ?? {};
      if (par.type === 'page_id') return par.page_id;
      if (par.type === 'block_id') { id = par.block_id; continue; }
      return null;
    }
    return null;
  }

  /** Processes the discovery queue with a pool of workers (requests stay under the client's rate limit). */
  private async drain(queue: QueueEntry[], push: (e: QueueEntry) => void) {
    const limit = Math.max(1, this.opts.concurrency ?? 4);
    let active = 0;
    let n = this.items.size;
    let stop = false;
    await new Promise<void>((resolve, reject) => {
      const pump = () => {
        if (this.cancelled) return reject(new NotionApiError(0, 'cancelled', 'Import cancelled'));
        while (!stop && active < limit && queue.length) {
          if (this.opts.maxItems && this.items.size >= this.opts.maxItems) {
            this.warn('limit', `Stopped at ${this.opts.maxItems} items (trial import limit); ${queue.length} more not imported`);
            queue.length = 0;
            stop = true;
            break;
          }
          const it = queue.shift()!;
          active++;
          this.process(it, push)
            .catch((e: any) => {
              if (e?.code === 'cancelled') { stop = true; queue.length = 0; return reject(e); }
              this.warn('fetch_failed', `Could not read ${it.kind === 'unknown' ? 'item' : it.kind} (${e.message})`, it.id);
            })
            .finally(() => {
              active--;
              this.onProgress('discovering', ++n, n + queue.length + active);
              pump();
            });
        }
        if (active === 0 && (queue.length === 0 || stop)) resolve();
      };
      pump();
    });
  }

  /** Notion ids of private roots (from the map), dashed. */
  private privateRootIds() {
    const out = new Set<string>();
    for (const t of this.opts.teamspaces ?? []) if (t.kind === 'private') for (const r of t.rootIds) { const n = normalizeNotionId(r); if (n) out.add(n); }
    return out;
  }

  private async process(it: QueueEntry, push: (e: QueueEntry) => void) {
    this.check();
    if (this.opts.privatePages === 'skip' && this.skipPrivate.has(it.id)) {
      this.counts.privateSkipped = (this.counts.privateSkipped ?? 0) + 1;
      return;
    }
    let kind = it.kind;
    let page: any;
    if (kind === 'unknown' || kind === 'page') {
      try {
        page = await this.client.page(it.id);
        kind = 'page';
      } catch (e: any) {
        if (kind === 'page' || !(e instanceof NotionApiError) || ![400, 404].includes(e.status)) throw e;
        kind = 'database';
      }
    }
    if (kind === 'database') {
      const before = this.order.length;
      await this.discoverDatabase(it.id, it.parent, !!it.inline, push, it.pos);
      for (const nid of this.order.slice(before)) {
        const x = this.items.get(nid)!;
        x.depth = it.depth ?? 0;
      }
      return;
    }
    if (page.archived || page.is_archived || page.in_trash) return;
    // A row reached via follow-links: import its whole database instead.
    if (!it.parent && (page.parent?.type === 'data_source_id' || page.parent?.type === 'database_id')) {
      const ds = page.parent.data_source_id;
      const dbId = page.parent.database_id ?? (ds ? (await this.client.dataSource(ds).catch(() => null))?.parent?.database_id : null);
      if (dbId) push({ kind: 'database', id: dbId, parent: null, depth: it.depth });
      return;
    }
    const item: Item = { kind: 'page', notionId: page.id, raw: page, parent: it.parent, title: this.pageTitle(page), order: it.pos ?? this.order.length, depth: it.depth ?? 0 };
    this.items.set(page.id, item);
    this.order.push(page.id);
    const kids = await this.fetchContent(item);
    kids.forEach((c, i) => push({ kind: c.kind, id: c.id, parent: page.id, inline: c.inline, pos: i, depth: it.depth }));
  }

  private async discoverDatabase(id: string, parent: string | null, inline: boolean, push: (e: QueueEntry) => void, pos?: number) {
    let db: any;
    try {
      db = await this.client.database(id);
    } catch (e: any) {
      if (inline) this.warn('linked_database', `Inline database could not be read (linked databases aren't available through the API)`, id);
      throw e;
    }
    if (db.archived || db.is_archived || db.in_trash) return;
    const sources: any[] = db.data_sources ?? [];
    if (!sources.length) {
      // A linked view of another database: the container has no data sources of its own, but its
      // views name the source data source. Import the source and show it here as a linked view.
      const views = await this.client.views(id).catch(() => [] as any[]);
      const sourceDsId = views.find((v) => v.data_source_id)?.data_source_id;
      if (!sourceDsId) { this.warn('linked_database', `Linked database "${plain(db.title)}" has no readable source`, id); return; }
      this.linked.set(id, { sourceDsId, views, parent });
      if (!this.dataSources.has(sourceDsId)) {
        try {
          const src = await this.client.dataSource(sourceDsId);
          const srcDb = src.parent?.database_id;
          if (srcDb) push({ kind: 'database', id: srcDb, parent: null });
        } catch (e: any) {
          this.warn('linked_database', `Source of linked database "${plain(db.title)}" isn't shared with the integration`, id);
        }
      }
      return;
    }
    if (sources.length > 1) this.warn('data_sources', `Database "${plain(db.title)}" has ${sources.length} data sources; each becomes its own Atrium database`, id);
    for (let i = 0; i < sources.length; i++) {
      const dsRef = sources[i];
      const ds = await this.client.dataSource(dsRef.id);
      const cap = this.opts.maxRowsPerSource;
      // Queries can also return data_source objects (databases that live inside row pages); those are found when
      // the row's body is read, so keep only real rows here.
      let rows = (await this.client.queryDataSource(dsRef.id, cap ? cap + 1 : Infinity)).filter(
        (r: any) => (r.object ?? 'page') === 'page' && !r.archived && !r.is_archived && !r.in_trash,
      );
      if (cap && rows.length > cap) {
        this.warn('limit', `Only the first ${cap} rows imported (trial import limit)`, ds.id);
        rows = rows.slice(0, cap);
      }
      let templates: any[] = [];
      try {
        templates = await this.client.dataSourceTemplates(dsRef.id);
      } catch {
        /* templates endpoint optional */
      }
      this.dataSources.set(ds.id, { id: ds.id, databaseId: db.id, raw: ds, rows, templates });
      const key = i === 0 ? db.id : ds.id;
      const title = i === 0 ? plain(db.title) || plain(ds.title) : `${plain(db.title)} – ${plain(ds.title) || dsRef.name || 'Source ' + (i + 1)}`;
      const item: Item = { kind: 'database', notionId: key, raw: { ...db, _dataSource: ds }, parent, dataSourceId: ds.id, title, order: pos ?? this.order.length, inline };
      this.items.set(key, item);
      this.order.push(key);
      for (const p of Object.values(ds.properties ?? {}) as any[]) this.tally('propertyTypes', p.type);
      const rowItems: Item[] = rows.map((r: any, ri: number) => ({ kind: 'row', notionId: r.id, raw: r, parent: key, dataSourceId: ds.id, title: this.pageTitle(r), order: ri }));
      for (const ri of rowItems) {
        this.items.set(ri.notionId, ri);
        this.order.push(ri.notionId);
      }
      // Row bodies in parallel (each is one Markdown request, or a block-tree walk).
      await mapLimit(rowItems, this.opts.concurrency ?? 4, async (ri) => {
        if (ri.raw.has_children === false) return;
        const kids = await this.fetchContent(ri);
        kids.forEach((c, i) => push({ kind: c.kind, id: c.id, parent: ri.notionId, inline: c.inline, pos: i }));
      });
      for (const [ti, t] of templates.entries()) {
        try {
          const tp = await this.client.page(t.id);
          const tItem: Item = { kind: 'template', notionId: tp.id, raw: { ...tp, _isDefault: !!t.is_default }, parent: key, dataSourceId: ds.id, title: t.name ?? this.pageTitle(tp), order: ti };
          this.items.set(tp.id, tItem);
          this.order.push(tp.id);
          await this.fetchContent(tItem);
        } catch (e: any) {
          this.warn('template', `Template "${t.name ?? t.id}" could not be read (${e.message})`, t.id);
        }
      }
    }
    try {
      const views = await this.client.views(db.id);
      for (const v of views) {
        this.tally('viewTypes', v.type ?? 'unknown');
        if (v.quick_filters && Object.keys(v.quick_filters).length) this.tally('viewFeatures', 'quick_filters');
      }
      this.dbViews.set(db.id, views);
    } catch (e: any) {
      this.warn('views', `Views of "${plain(db.title)}" could not be read (${e.message}); a default table view was created`, db.id);
    }
  }

  summary() {
    const by = (k: Kind) => [...this.items.values()].filter((i) => i.kind === k).length;
    return {
      pages: by('page'), databases: by('database'), rows: by('row'), templates: by('template'), blocks: this.counts.blocks,
      views: [...this.dbViews.values()].reduce((a, v) => a + v.length, 0),
      roots: this.order
        .map((id) => this.items.get(id)!)
        .filter((i) => !i.parent)
        .map((i) => {
          const par = i.raw?.parent ?? {};
          // Roots whose Notion parent the integration can't see share a "hidden parent" — the preview groups them.
          const hiddenParent = par.type === 'page_id' ? par.page_id : par.type === 'block_id' ? par.block_id : null;
          const spec = (this.opts.teamspaces ?? []).find((t) => t.rootIds.some((r) => normalizeNotionId(r) === i.notionId));
          return {
            notionId: i.notionId, title: i.title || 'Untitled', kind: i.kind, parentType: par.type ?? null, hiddenParent, depth: i.depth ?? 0,
            teamspace: spec?.kind === 'private' ? null : spec?.name ?? null,
            ...(spec?.kind === 'private' ? { privateOwner: spec.ownerEmail ?? spec.name } : {}),
            createdBy: i.raw?.created_by?.id ?? null,
          };
        }),
    };
  }

  /**
   * Census (dry run): converts every discovered body in memory — no database writes — and tallies block,
   * inline, property and view types plus every warning category. Counts only, never content.
   */
  async runCensus() {
    const fakePage = (nid: string) => (this.items.has(nid) ? { id: nid, title: '' } : undefined);
    const tallyBlocks = (blocks: any[]) => {
      for (const b of blocks) {
        this.tally('atriumBlocks', b.type);
        for (const c of Array.isArray(b.content) ? b.content : []) {
          if (c.type === 'mention') this.tally('inline', `mention:${c.props?.kind}`);
          else if (c.type === 'link') this.tally('inline', 'link');
          else if (c.type === 'inlineEquation') this.tally('inline', 'equation');
          for (const k of Object.keys(c.styles ?? {})) this.tally('inline', `style:${k}`);
        }
        if (b.children?.length) tallyBlocks(b.children);
      }
    };
    for (const nid of this.order) {
      const it = this.items.get(nid)!;
      this.tally('items', it.kind);
      if (it.kind === 'database') continue;
      this.currentPage = nid;
      if (it.md !== undefined) {
        this.tally('source', 'markdown');
        for (const t of it.md.matchAll(/<([a-zA-Z][\w-]*)/g)) this.tally('notionTags', t[1].toLowerCase());
        this.tally('files', 'notion_hosted', (it.md.match(/prod-files-secure|secure\.notion-static|file\.notion\.so/g) ?? []).length);
        const res = richToBlocks(it.md, {
          lineBlocks: true,
          resolveUrl: (url) => {
            const id = notionIdFromUrl(url);
            if (id && this.items.has(id)) return { kind: this.items.get(id)!.kind === 'database' ? 'database' : 'page', id, title: '' };
            if (id) this.noteRef(id, nid);
            return null;
          },
        });
        for (const w of res.warnings) this.warn(markdownWarnKind(w), importWording(w), nid);
        tallyBlocks(res.blocks);
      } else {
        this.tally('source', 'blocks');
        const walk = (id: string) => {
          for (const b of this.children.get(id) ?? []) {
            this.tally('notionBlocks', b.type);
            if (['image', 'video', 'audio', 'file', 'pdf'].includes(b.type)) this.tally('files', b[b.type]?.type ?? 'unknown');
            if (b.has_children && b.type !== 'child_page' && b.type !== 'child_database') walk(b.id);
          }
        };
        walk(nid);
        // Conversion in memory to surface warnings (files/synced/pages are stubbed — nothing is written).
        const converted = await convertBlocks(this.children.get(nid) ?? [], {
          ...this.ctx(),
          page: (x) => fakePage(x) ?? (this.noteRef(x, nid), undefined),
          file: async (f) => f?.external?.url ?? f?.file?.url ?? 'file',
          synced: async () => 'synced',
          linked: (x) => (this.linked.has(x) ? { databaseId: x } : undefined),
        });
        tallyBlocks(converted);
      }
      if (it.inlineComments?.size) this.tally('comments', 'inline_threads', it.inlineComments.size);
    }
    this.currentPage = null;
    for (const [, views] of this.dbViews) {
      for (const v of views) {
        const conv = convertView(v, [], { ...this.ctx(), warn: () => {} });
        this.tally('atriumViewTypes', conv.type);
        const walkFilter = (f: any) => {
          if (!f) return;
          if (Array.isArray(f.and) || Array.isArray(f.or)) return (f.and ?? f.or).forEach(walkFilter);
          const key = Object.keys(f).find((k) => !['property', 'timestamp', 'type'].includes(k));
          const op = key ? Object.keys(f[key] ?? {})[0] : undefined;
          if (key && op) this.tally('filterOperators', `${key}.${op}`);
        };
        walkFilter(v.filter);
      }
    }
    this.counts.unresolvedLinks = [...this.unresolved.keys()].filter((t) => !this.items.has(t)).length;
  }

  // ---------------------------------------------------------------- people

  async mapPeople() {
    this.onProgress('people', 0, 0);
    let users: any[] = [];
    try {
      users = await this.client.users();
    } catch (e: any) {
      this.warn('users', `Couldn't list Notion users (${e.message}). Give the integration "Read user information including email addresses".`);
    }
    const ws = this.admin.workspaceId;
    for (const u of users) {
      this.notionUsers.set(u.id, u);
      if (u.type !== 'person') continue;
      const email = String(u.person?.email ?? '').toLowerCase().trim();
      if (email) {
        const found = await one<{ id: string; name: string }>(
          `select u.id, u.name from users u join workspace_members m on m.user_id = u.id and m.workspace_id = $2 where lower(u.email) = $1 and u.deleted_at is null`,
          [email, ws],
        ).catch(() => one<{ id: string; name: string }>(`select u.id, u.name from users u join workspace_members m on m.user_id = u.id and m.workspace_id = $2 where lower(u.email) = $1`, [email, ws]));
        if (found) { this.userMap.set(u.id, found); this.counts.people.matched++; continue; }
        if (this.opts.peopleMode === 'guests' && !this.opts.dryRun) {
          const existingUser = await one<{ id: string }>('select id from users where lower(email) = $1', [email]);
          let id = existingUser?.id;
          if (!id) {
            const created = await one<{ id: string }>(
              `insert into users(email, name, password_hash) values ($1,$2,$3) returning id`,
              [email, u.name || email.split('@')[0], await hashPassword(randomBytes(24).toString('hex'))],
            );
            id = created!.id;
          }
          await q(`insert into workspace_members(workspace_id, user_id, role) values ($1,$2,'guest') on conflict do nothing`, [ws, id]);
          await this.recordMapping(u.id, id, 'user', null);
          this.userMap.set(u.id, { id, name: u.name || email });
          this.counts.people.created++;
          continue;
        }
      }
      this.counts.people.unmatched++;
      this.warn('person_unmatched', `${u.name || 'A Notion user'}${email ? ` (${email})` : ''} has no Atrium account${this.opts.peopleMode === 'text' ? ' — shown as text' : ''}`, u.id);
    }
  }

  userName(id: string) {
    return this.notionUsers.get(id)?.name ?? 'Someone';
  }

  // ---------------------------------------------------------------- mappings

  async loadMappings() {
    const ids = [...this.items.keys(), ...this.dataSources.keys()];
    if (!ids.length) return;
    const rows = await q(
      `select m.source_id, m.atrium_id, m.source_last_edited from import_mappings m
       join pages p on p.id = m.atrium_id and p.deleted_at is null
       where m.source = 'notion' and m.source_id = any($1::text[])`,
      [ids],
    );
    for (const r of rows) this.existing.set(r.source_id, { atrium_id: r.atrium_id, source_last_edited: r.source_last_edited });
  }

  async recordMapping(sourceId: string, atriumId: string, kind: string, lastEdited: string | null) {
    await q(
      `insert into import_mappings(source, source_id, atrium_id, kind, job_id, source_last_edited) values ('notion',$1,$2,$3,$4,$5)
       on conflict (source, source_id) do update set atrium_id = excluded.atrium_id, kind = excluded.kind, job_id = excluded.job_id,
         source_last_edited = coalesce(excluded.source_last_edited, import_mappings.source_last_edited), updated_at = now()`,
      [sourceId, atriumId, kind, this.jobId, lastEdited],
    );
  }

  jobId: string | null = null;

  // ---------------------------------------------------------------- write

  private ctx(): ConvertCtx {
    return {
      page: (nid) => {
        const p = this.atrium.get(nid);
        if (!p && this.currentPage) this.noteRef(nid, this.currentPage);
        return p;
      },
      user: (uid) => (this.opts.peopleMode === 'text' ? undefined : this.userMap.get(uid)),
      userName: (uid) => this.userName(uid),
      file: (f, name) => this.rehost(f, name),
      synced: (bid) => this.syncedSource(bid),
      children: (bid) => this.children.get(bid) ?? [],
      linked: (nid) => {
        const l = this.linked.get(nid);
        const id = l ? this.atrium.get(l.sourceDsId)?.id : undefined;
        return id ? { databaseId: id } : undefined;
      },
      warn: this.warn,
    };
  }

  private async rehost(f: any, name?: string): Promise<string | null> {
    if (!f) return null;
    if (f.type === 'external') {
      this.counts.files.external++;
      return f.external?.url ?? null;
    }
    const url: string | undefined = f.file?.url ?? f.file_upload?.url ?? f.url;
    if (!url) return null;
    const key = url.split('?')[0];
    if (this.fileCache.has(key)) { this.counts.files.reused++; return this.fileCache.get(key)!; }
    const mapped = await one<{ atrium_id: string; meta: any }>(`select atrium_id, meta from import_mappings where source = 'notion-file' and source_id = $1`, [key]).catch(() => undefined);
    if (mapped?.meta?.url) { this.fileCache.set(key, mapped.meta.url); this.counts.files.reused++; return mapped.meta.url; }
    try {
      const fileImporter = this.deps.fileImporter ?? importFileFromUrl;
      const pageId = this.currentPage ? this.atrium.get(this.currentPage)?.id ?? null : null;
      const stored = await fileImporter(this.admin, url, { name: name ?? decodeURIComponent(key.split('/').pop() ?? 'file'), pageId });
      this.fileCache.set(key, stored.url);
      await q(
        `insert into import_mappings(source, source_id, atrium_id, kind, job_id, meta) values ('notion-file',$1,$2,'file',$3,$4)
         on conflict (source, source_id) do update set atrium_id = excluded.atrium_id, meta = excluded.meta, updated_at = now()`,
        [key, stored.id, this.jobId, { url: stored.url, name: stored.name }],
      );
      this.counts.files.rehosted++;
      return stored.url;
    } catch (e: any) {
      this.counts.files.failed++;
      this.warn('file_failed', `File "${name ?? key.split('/').pop()}" could not be copied (${e.message})`);
      return null;
    }
  }

  private async syncedSource(notionBlockId: string): Promise<string | null> {
    if (this.syncedDone.has(notionBlockId)) return this.syncedDone.get(notionBlockId)!;
    const hostAtrium = this.currentPage ? this.atrium.get(this.currentPage)?.id : undefined;
    if (!hostAtrium) return null;
    let children = this.children.get(notionBlockId);
    if (!children) {
      try {
        children = await this.fetchTree(notionBlockId);
      } catch {
        return null;
      }
    }
    const map = await one<{ atrium_id: string }>(
      `select m.atrium_id from import_mappings m join pages p on p.id = m.atrium_id where m.source = 'notion' and m.source_id = $1`,
      [`synced:${notionBlockId}`],
    );
    let id = map?.atrium_id;
    if (!id) {
      const host = await one('select workspace_id, teamspace_id, owner_id from pages where id = $1', [hostAtrium]);
      id = (await one<{ id: string }>(
        `insert into pages(workspace_id, parent_id, teamspace_id, owner_id, kind, title, created_by, updated_by) values ($1,$2,$3,$4,'synced','',$5,$5) returning id`,
        [host.workspace_id, hostAtrium, host.teamspace_id, host.owner_id, this.admin.id],
      ))!.id;
      await this.recordMapping(`synced:${notionBlockId}`, id, 'synced', null);
    }
    this.syncedDone.set(notionBlockId, id);
    const blocks = await convertBlocks(children, this.ctx());
    await this.writeDoc(id, blocks, !map);
    return id;
  }

  /** Converts blocks to a Yjs doc, isolating any block BlockNote rejects so one bad block can't sink a page. */
  private toDoc(blocks: any[]): Y.Doc {
    try {
      return blocksToDoc(blocks);
    } catch {
      // Isolate the smallest failing block: keep each block's own content and replace only the descendant
      // BlockNote rejects, so one bad child can't erase a whole toggle/heading subtree.
      const note = (type: string) => ({ type: 'paragraph', content: [{ type: 'text', text: `[${type} could not be imported]`, styles: { italic: true } }], children: [] });
      const sanitize = (b: any): any[] => {
        try {
          blocksToDoc([b]);
          return [b];
        } catch (e: any) {
          if (b.children?.length) {
            const kids = b.children.flatMap(sanitize);
            try {
              blocksToDoc([{ ...b, children: kids }]);
              return [{ ...b, children: kids }];
            } catch {}
            try {
              blocksToDoc([{ ...b, children: [] }]);
              this.warn('block_rejected', `A ${b.type} block's children could not be nested in Atrium; they were placed directly below it`);
              return [{ ...b, children: [] }, ...kids];
            } catch {}
          }
          this.warn('block_rejected', `A ${b.type} block could not be converted (${e.message}); replaced with a note`);
          return [note(b.type)];
        }
      };
      return blocksToDoc(blocks.flatMap(sanitize));
    }
  }

  private async writeDoc(atriumId: string, blocks: any[], isNew: boolean) {
    const doc = this.toDoc(blocks.length ? blocks : [{ type: 'paragraph', content: [], children: [] }]);
    if (!isNew && hocuspocus.documents.has(atriumId)) await replaceDocContent(atriumId, doc);
    await persistDoc(atriumId, doc, this.admin.id);
  }

  private changed(notionId: string, lastEdited: string | undefined) {
    if (this.opts.force) return true;
    const ex = this.existing.get(notionId);
    if (!ex) return true;
    return !ex.source_last_edited || !lastEdited || new Date(ex.source_last_edited).getTime() !== new Date(lastEdited).getTime();
  }

  /** Creates (or reuses) the Atrium teamspaces named in opts.teamspaces and records which roots go where. */
  async ensureTeamspaces() {
    const ws = this.admin.workspaceId;
    for (const spec of this.opts.teamspaces ?? []) {
      if (!spec?.name?.trim() || !spec.rootIds?.length) continue;
      if (spec.kind === 'private') {
        if (this.opts.privatePages !== 'skip') await this.ensurePrivateOwner(spec);
        continue;
      }
      const key = spec.notionTeamspaceId ? `teamspace:${spec.notionTeamspaceId}` : `teamspace-name:${spec.name.trim().toLowerCase()}`;
      let id = (await one<{ atrium_id: string }>(
        `select m.atrium_id from import_mappings m join teamspaces t on t.id = m.atrium_id where m.source = 'notion' and m.source_id = $1`,
        [key],
      ))?.atrium_id;
      let created = false;
      if (!id) id = (await one<{ id: string }>(`select id from teamspaces where workspace_id = $1 and lower(name) = lower($2)`, [ws, spec.name.trim()]))?.id;
      if (!id) {
        id = (await one<{ id: string }>(
          `insert into teamspaces(workspace_id, name, icon, is_default, position)
           values ($1,$2,$3,$4,(select coalesce(max(position),0)+1 from teamspaces where workspace_id = $1)) returning id`,
          [ws, spec.name.trim(), spec.icon ?? '📁', spec.access !== 'members'],
        ))!.id;
        await q(`insert into teamspace_members(teamspace_id, user_id, role) values ($1,$2,'owner') on conflict do nothing`, [id, this.admin.id]);
        created = true;
      }
      await this.recordMapping(key, id, 'teamspace', null);
      for (const email of spec.members ?? []) {
        const u = await one<{ id: string }>(`select id from users where lower(email) = lower($1)`, [email.trim()]);
        if (u) await q(`insert into teamspace_members(teamspace_id, user_id, role) values ($1,$2,'member') on conflict do nothing`, [id, u.id]);
        else this.warn('teamspace_member', `${email} is listed for "${spec.name}" but has no Atrium account`);
      }
      this.teamspaceIds.push({ name: spec.name.trim(), id, created });
      for (const r of spec.rootIds) {
        const nid = normalizeNotionId(r);
        if (nid) this.rootTeamspace.set(nid, id);
      }
    }
  }

  /**
   * Private roots: the owner (matched by email) gets them in their Private section. A missing account is created
   * as a workspace member with an unusable password and no email sent, so the pages are theirs on first SSO sign-in.
   * Without a usable owner the roots are left out — private pages never fall back to a shared teamspace.
   */
  private async ensurePrivateOwner(spec: TeamspaceSpec) {
    const ws = this.admin.workspaceId;
    const email = String(spec.ownerEmail ?? '').trim().toLowerCase();
    const roots = spec.rootIds.map((r) => normalizeNotionId(r)).filter(Boolean) as string[];
    if (!/^[^@\s]+@[^@\s]+$/.test(email)) {
      this.warn('private_owner', `Private pages of "${spec.name}" have no owner email; ${roots.length} left out`);
      for (const r of roots) this.rootOwner.set(r, '');
      return;
    }
    let user = await one<{ id: string }>(`select id from users where lower(email) = $1`, [email]);
    let created = false;
    if (!user && !this.opts.dryRun) {
      user = await one<{ id: string }>(`insert into users(email, name, password_hash) values ($1,$2,$3) returning id`, [
        email, (() => { const n = spec.name.replace(/^Private\s*[—-]\s*/i, '').trim(); return !n || n.includes('@') ? email.split('@')[0] : n; })(), await hashPassword(randomBytes(32).toString('hex')),
      ]);
      created = true;
    }
    if (user && !this.opts.dryRun) {
      await q(`insert into workspace_members(workspace_id, user_id, role) values ($1,$2,'member') on conflict do nothing`, [ws, user.id]);
    }
    for (const r of roots) this.rootOwner.set(r, user?.id ?? '');
    this.privateOwners.push({ email, id: user?.id ?? '', created, roots: roots.length });
  }

  /** Where an item goes: the nearest mapped ancestor (or itself) decides — a teamspace, or an owner's Private section. */
  placementFor(nid: string): { teamspaceId: string | null; ownerId: string | null } {
    let cur: string | null = nid;
    for (let i = 0; cur && i < 200; i++) {
      if (this.rootOwner.has(cur)) return { teamspaceId: null, ownerId: this.rootOwner.get(cur) || null };
      const ts = this.rootTeamspace.get(cur);
      if (ts) return { teamspaceId: ts, ownerId: null };
      cur = this.items.get(cur)?.parent ?? null;
    }
    return { teamspaceId: this.opts.targetTeamspaceId, ownerId: null };
  }

  teamspaceFor(nid: string): string | null {
    return this.placementFor(nid).teamspaceId;
  }

  /** Resolves a URL inside Notion Markdown to an imported Atrium page/database/user. */
  private resolveUrl = (url: string) => {
    const um = url.match(/^\{?\{?user:\/\/([0-9a-f-]{32,36})\}?\}?$/i);
    if (um) {
      const u = this.opts.peopleMode === 'text' ? undefined : this.userMap.get(normalizeNotionId(um[1]) ?? '');
      return u ? { kind: 'user' as const, id: u.id, title: u.name } : null;
    }
    const nid = notionIdFromUrl(url) ?? (/^[0-9a-f-]{32,36}$/i.test(url) ? normalizeNotionId(url) : null);
    if (!nid) return null;
    const p = this.atrium.get(nid);
    if (!p) {
      if (this.currentPage) this.noteRef(nid, this.currentPage);
      return null;
    }
    const kind = this.items.get(nid)?.kind === 'database' ? ('database' as const) : ('page' as const);
    return { kind, id: p.id, title: p.title };
  };

  /** Rehosts Notion-hosted files referenced by Markdown-converted blocks (signed S3 URLs expire in ~1h). */
  private async rehostBlocks(blocks: any[]): Promise<any[]> {
    const hosted = (u: string) => /^https?:\/\/(prod-files-secure\.s3[.\w-]*amazonaws\.com|s3[.\w-]*amazonaws\.com\/secure\.notion-static|file\.notion\.so|[\w-]+\.notion-static\.com)\//i.test(u);
    const walk = async (list: any[]) => {
      for (const b of list) {
        if (['image', 'video', 'audio', 'file'].includes(b.type) && typeof b.props?.url === 'string') {
          if (hosted(b.props.url)) {
            const url = await this.rehost({ type: 'file', file: { url: b.props.url } }, b.props.name || undefined);
            if (url) b.props.url = url;
            else b.props.url = '';
          } else if (b.props.url.startsWith('notion-file-block://') || b.props.url.startsWith('attachment:')) {
            this.warn('file_failed', `File "${b.props.name ?? 'file'}" uses an internal Notion reference and couldn't be copied`);
          } else if (b.props.url) this.counts.files.external++;
        }
        if (b.type === 'callout' && /^https?:\/\//.test(b.props?.emoji ?? '')) {
          b.props.emoji = hosted(b.props.emoji) ? (await this.rehost({ type: 'file', file: { url: b.props.emoji } }, 'icon')) ?? '💡' : b.props.emoji;
        }
        if (b.children?.length) await walk(b.children);
      }
    };
    await walk(blocks);
    return blocks;
  }

  /** Converts an item's body (Markdown or block tree) to Atrium blocks. */
  private async bodyBlocks(it: Item): Promise<any[]> {
    if (it.md !== undefined) {
      const res = richToBlocks(it.md, {
          lineBlocks: true, resolveUrl: this.resolveUrl });
      for (const w of res.warnings) this.warn(markdownWarnKind(w), importWording(w), it.notionId);
      // Plain Markdown links to Notion pages aren't resolved by the parser: point them at the Atrium copies
      // (as the block-tree path does), or record them for relinking.
      const fix = (list: any[]) => {
        for (const b of list) {
          for (const c of Array.isArray(b.content) ? b.content : []) {
            if (c.type !== 'link' || !notionIdFromUrl(c.href ?? '')) continue;
            const ref = this.resolveUrl(c.href);
            if (ref && ref.kind !== 'user') c.href = `/p/${ref.id}`;
          }
          if (b.children?.length) fix(b.children);
        }
      };
      fix(res.blocks);
      return this.rehostBlocks(res.blocks);
    }
    return convertBlocks(this.children.get(it.notionId) ?? [], this.ctx());
  }

  async write() {
    const ws = this.admin.workspaceId;
    await this.ensureTeamspaces();
    await this.loadMappings();
    // Private pages whose owner couldn't be resolved are left out entirely (never placed in a shared teamspace).
    const before = this.order.length;
    this.order = this.order.filter((nid) => {
      const p = this.placementFor(nid);
      return p.teamspaceId !== null || p.ownerId !== null;
    });
    if (before !== this.order.length) this.counts.privateSkipped = (this.counts.privateSkipped ?? 0) + before - this.order.length;
    const total = this.order.length;

    // ---- skeleton
    let i = 0;
    for (const nid of this.order) {
      this.check();
      const it = this.items.get(nid)!;
      this.onProgress('pages', ++i, total);
      const parentAtrium = it.parent ? this.atrium.get(it.parent)?.id ?? null : null;
      const place = this.placementFor(nid);
      const ts = place.teamspaceId;
      const owner = place.ownerId ?? this.admin.id;
      const kind = it.kind === 'template' ? 'row' : it.kind;
      const ex = this.existing.get(nid);
      const bucket = it.kind === 'database' ? 'databases' : it.kind === 'row' || it.kind === 'template' ? 'rows' : 'pages';
      if (ex) {
        await q(
          `update pages set title = $2, parent_id = coalesce($3, parent_id), position = $4, is_template = $5, teamspace_id = $6,
             owner_id = case when $6::uuid is null then $7::uuid else owner_id end where id = $1`,
          [ex.atrium_id, it.title, parentAtrium, it.order, it.kind === 'template', ts, owner],
        );
        this.atrium.set(nid, { id: ex.atrium_id, title: it.title });
        if (!this.changed(nid, it.raw.last_edited_time)) this.counts[bucket].skipped++;
        else this.counts[bucket].updated++;
      } else {
        const row = await one<{ id: string }>(
          `insert into pages(workspace_id, parent_id, teamspace_id, owner_id, kind, title, position, is_template, created_by, updated_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) returning id`,
          [ws, parentAtrium, ts, owner, kind, it.title, it.order, it.kind === 'template', this.admin.id],
        );
        this.atrium.set(nid, { id: row!.id, title: it.title });
        await this.recordMapping(nid, row!.id, it.kind, null);
        this.counts[bucket].created++;
        if (it.kind === 'template') this.counts.templates++;
      }
      if (it.kind === 'database' && it.dataSourceId) this.atrium.set(it.dataSourceId, this.atrium.get(nid)!);
      if (!it.parent) this.roots.push({ id: this.atrium.get(nid)!.id, title: it.title || 'Untitled', kind: it.kind, teamspaceId: ts ?? undefined, ...(ts ? {} : { ownerId: owner }) });
    }

    // ---- schemas (after every database exists, so relations resolve)
    const dbFor = (dsOrDbId: string) => this.atrium.get(dsOrDbId)?.id;
    const schemas = new Map<string, any[]>();
    for (const nid of this.order) {
      const it = this.items.get(nid)!;
      if (it.kind !== 'database') continue;
      this.currentPage = nid;
      const ds = this.dataSources.get(it.dataSourceId!)!;
      const schema = convertSchema(ds.id, ds.raw.properties ?? {}, dbFor, this.warn);
      schemas.set(ds.id, schema);
      const dbId = this.atrium.get(nid)!.id;
      await q(`insert into databases(page_id, schema) values ($1,$2) on conflict (page_id) do update set schema = excluded.schema`, [dbId, JSON.stringify(schema)]);
      const desc = plain(it.raw.description);
      await q(`update databases set description = $2 where page_id = $1`, [dbId, desc || null]);
      const icon = iconValue(it.raw.icon);
      const cover = it.raw.cover ? await this.rehost(it.raw.cover, 'cover') : null;
      await q(`update pages set icon = $2, cover = $3 where id = $1`, [dbId, icon?.emoji ?? (icon?.file ? await this.rehost(icon.file, 'icon') : null), cover]);
    }

    // ---- content + row values
    i = 0;
    for (const nid of this.order) {
      this.check();
      const it = this.items.get(nid)!;
      this.onProgress('content', ++i, total);
      const atriumId = this.atrium.get(nid)!.id;
      const isNew = !this.existing.has(nid);
      if (it.kind === 'database') {
        this.touched.add(nid);
        continue;
      }
      if (!this.changed(nid, it.raw.last_edited_time)) continue;
      this.currentPage = nid;
      this.touched.add(nid);
      const ctx = this.ctx();
      const icon = iconValue(it.raw.icon);
      const iconVal = icon?.emoji ?? (icon?.file ? await this.rehost(icon.file, 'icon') : null);
      const cover = it.raw.cover ? await this.rehost(it.raw.cover, 'cover') : null;
      const pos = it.raw.cover?.position;
      let props: Record<string, any> | null = null;
      const ver = it.raw.verification;
      if (ver?.state && ver.state !== 'unverified') {
        props = {
          __verification: {
            state: ver.state,
            ...(ver.verified_by?.id && this.userMap.get(ver.verified_by.id) ? { by: this.userMap.get(ver.verified_by.id)!.id } : {}),
            ...(ver.date?.start ? { at: ver.date.start } : {}),
            ...(ver.date?.end ? { until: ver.date.end } : {}),
          },
        };
      }
      if ((it.kind === 'row' || it.kind === 'template') && it.dataSourceId) {
        const r = await convertRowProps(it.dataSourceId, it.raw.properties ?? {}, schemas.get(it.dataSourceId) ?? [], ctx, async (propNotionId) => {
          const items = await this.client.pageProperty(it.notionId, propNotionId);
          return items.map((x: any) => x.relation?.id).filter(Boolean);
        });
        props = { ...(props ?? {}), ...r.props };
      }
      await q(
        `update pages set icon = $2, cover = $3, cover_position = coalesce($4, cover_position), props = coalesce($5, props) where id = $1`,
        [atriumId, iconVal, cover, typeof pos === 'number' ? Math.round((1 - pos) * 100) : null, props ? JSON.stringify(props) : null],
      );
      let blocks = await this.bodyBlocks(it);
      if (it.inlineComments?.size) blocks = await this.anchorInlineComments(it, atriumId, blocks);
      await this.writeDoc(atriumId, blocks, isNew);
    }
    this.currentPage = null;

    // ---- views
    for (const nid of this.order) {
      const it = this.items.get(nid)!;
      if (it.kind !== 'database') continue;
      const dbId = this.atrium.get(nid)!.id;
      const schema = schemas.get(it.dataSourceId!) ?? [];
      const allViews = this.dbViews.get(it.raw.id) ?? [];
      const views = allViews.filter((v) => !v.data_source_id || v.data_source_id === it.dataSourceId);
      // Notion lets a database hold views of OTHER data sources; Atrium views belong to one database.
      const ownSources = new Set([...this.dataSources.values()].filter((d) => d.databaseId === it.raw.id).map((d) => d.id));
      for (const v of allViews) {
        if (v.data_source_id && v.data_source_id !== it.dataSourceId && !ownSources.has(v.data_source_id)) {
          this.warn('view_other_source', `View "${v.name || 'View'}" of "${it.title}" shows a different database; Atrium views belong to one database, so it was not imported here (add a linked view of that database instead)`, nid);
        }
      }
      const ctx = this.ctx();
      const existingViews = await q<{ id: string; source_id: string }>(
        `select v.id, m.source_id from database_views v join import_mappings m on m.atrium_id = v.id and m.source = 'notion-view' where v.database_id = $1`,
        [dbId],
      );
      let pos = 0;
      for (const v of views) {
        const conv = convertView(v, schema, ctx);
        const ex = existingViews.find((e) => e.source_id === v.id);
        if (ex) {
          await q(`update database_views set name = $2, type = $3, config = $4, position = $5 where id = $1`, [ex.id, conv.name, conv.type, JSON.stringify(conv.config), pos++]);
        } else {
          const nv = await one<{ id: string }>(
            `insert into database_views(database_id, name, type, config, position) values ($1,$2,$3,$4,$5) returning id`,
            [dbId, conv.name, conv.type, JSON.stringify(conv.config), pos++],
          );
          await q(
            `insert into import_mappings(source, source_id, atrium_id, kind, job_id) values ('notion-view',$1,$2,'view',$3)
             on conflict (source, source_id) do update set atrium_id = excluded.atrium_id, updated_at = now()`,
            [v.id, nv!.id, this.jobId],
          );
        }
        this.counts.views++;
      }
      // Fallback default view (only when Notion gave no readable views) is tracked so a later run that does find
      // the real views removes it instead of leaving an extra "Table" view behind.
      const fallbackKey = `defaultview:${nid}`;
      const fallback = await one<{ atrium_id: string }>(`select atrium_id from import_mappings where source = 'notion-view' and source_id = $1`, [fallbackKey]);
      if (views.length && fallback) {
        await q(`delete from database_views where id = $1 and database_id = $2`, [fallback.atrium_id, dbId]);
        await q(`delete from import_mappings where source = 'notion-view' and source_id = $1`, [fallbackKey]);
      }
      const n = await one<{ n: number }>(`select count(*)::int as n from database_views where database_id = $1`, [dbId]);
      if (!n?.n) {
        const dv = await one<{ id: string }>(`insert into database_views(database_id, name, type, config, position) values ($1,'Table','table','{}',0) returning id`, [dbId]);
        await q(
          `insert into import_mappings(source, source_id, atrium_id, kind, job_id) values ('notion-view',$1,$2,'view',$3)
           on conflict (source, source_id) do update set atrium_id = excluded.atrium_id, updated_at = now()`,
          [fallbackKey, dv!.id, this.jobId],
        );
      }
      const def = [...this.items.values()].find((x) => x.kind === 'template' && x.parent === nid && x.raw._isDefault);
      const defId = def ? this.atrium.get(def.notionId)?.id : null;
      await q(`update databases set default_template_id = $2 where page_id = $1`, [dbId, defId ?? null]);
    }

    // ---- linked database views: views scoped to the embedding block (block id = Notion id)
    for (const [nid, l] of this.linked) {
      const dbId = this.atrium.get(l.sourceDsId)?.id;
      if (!dbId) { this.warn('linked_database', 'A linked database view points at a database that was not imported', nid); continue; }
      const schema = schemas.get(l.sourceDsId) ?? [];
      const ctx = this.ctx();
      await q(`delete from database_views where database_id = $1 and block_id = $2`, [dbId, nid]);
      let pos = 0;
      for (const v of l.views.filter((x) => !x.data_source_id || x.data_source_id === l.sourceDsId)) {
        const conv = convertView(v, schema, ctx);
        await q(`insert into database_views(database_id, name, type, config, position, block_id) values ($1,$2,$3,$4,$5,$6)`, [dbId, conv.name, conv.type, JSON.stringify(conv.config), pos++, nid]);
        this.counts.views++;
      }
      this.counts.linkedViews = (this.counts.linkedViews ?? 0) + 1;
    }

    // ---- comments
    i = 0;
    const commentTargets = this.order.filter((nid) => this.touched.has(nid) && this.items.get(nid)!.kind !== 'database');
    let commentsAvailable = true;
    for (const nid of commentTargets) {
      if (!commentsAvailable) break;
      this.check();
      this.onProgress('comments', ++i, commentTargets.length);
      this.currentPage = nid;
      try {
        await this.importComments(nid);
      } catch (e: any) {
        if (e instanceof NotionApiError && (e.status === 403 || e.status === 401)) {
          commentsAvailable = false;
          this.warn('comments', 'Comments were skipped: give the integration the "Read comments" capability');
        } else this.warn('comments', `Comments could not be read (${e.message})`, nid);
      }
    }
    this.currentPage = null;

    // ---- original authors and timestamps
    this.onProgress('finishing', 0, 0);
    for (const nid of this.order) {
      const it = this.items.get(nid)!;
      if (!this.touched.has(nid) && this.existing.has(nid)) continue;
      const raw = it.kind === 'database' ? it.raw : it.raw;
      const cb = raw.created_by?.id ? this.userMap.get(raw.created_by.id)?.id ?? null : null;
      const eb = raw.last_edited_by?.id ? this.userMap.get(raw.last_edited_by.id)?.id ?? null : null;
      await q(
        `update pages set created_at = coalesce($2, created_at), updated_at = coalesce($3, updated_at),
           created_by = coalesce($4, created_by), updated_by = coalesce($5, updated_by) where id = $1`,
        [this.atrium.get(nid)!.id, raw.created_time ?? null, raw.last_edited_time ?? null, cb, eb],
      );
      await this.recordMapping(nid, this.atrium.get(nid)!.id, it.kind, raw.last_edited_time ?? null);
    }
    // Remember which pages still link to Notion pages that weren't imported, so a later import (or
    // POST /admin/import/relink) can point those links at the Atrium copies.
    const bySource = new Map<string, string[]>();
    for (const [target, sources] of this.unresolved) {
      if (this.atrium.has(target)) continue;
      for (const s of sources) {
        if (!bySource.has(s)) bySource.set(s, []);
        bySource.get(s)!.push(target);
      }
    }
    for (const nid of this.order) {
      if (!this.touched.has(nid)) continue;
      await q(`update import_mappings set meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object('unresolved', $2::jsonb) where source = 'notion' and source_id = $1`, [
        nid,
        JSON.stringify(bySource.get(nid) ?? []),
      ]);
    }
    this.counts.unresolvedLinks = [...this.unresolved.keys()].filter((t) => !this.atrium.has(t)).length;
    emit({ type: 'tree' });
    for (const nid of this.order) if (this.items.get(nid)!.kind === 'database') emit({ type: 'db', id: this.atrium.get(nid)!.id });
  }

  /** Creates Atrium threads for block-level Notion discussions and marks the commented blocks' text. */
  private async anchorInlineComments(it: Item, atriumPage: string, blocks: any[]): Promise<any[]> {
    const threadFor = new Map<string, string>();
    for (const [blockId, comments] of it.inlineComments!) {
      const byDiscussion = new Map<string, any[]>();
      for (const c of comments) {
        const k = c.discussion_id ?? c.id;
        if (!byDiscussion.has(k)) byDiscussion.set(k, []);
        byDiscussion.get(k)!.push(c);
      }
      for (const [discussion, cs] of byDiscussion) {
        const threadId = await this.importDiscussion(atriumPage, discussion, cs, blockId);
        if (threadId && !threadFor.has(blockId)) threadFor.set(blockId, threadId);
      }
    }
    const mark = (list: any[]) => {
      for (const b of list) {
        const t = threadFor.get(b.id);
        if (t && Array.isArray(b.content)) {
          for (const c of b.content) {
            if (c.type === 'text') c.styles = { ...c.styles, comment: t };
            if (c.type === 'link') for (const x of c.content ?? []) x.styles = { ...x.styles, comment: t };
          }
        }
        if (b.children?.length) mark(b.children);
      }
    };
    mark(blocks);
    return blocks;
  }

  private commentBody(rt: any[]) {
    return (rt ?? [])
      .map((t: any) => {
        if (t.type === 'mention' && t.mention?.type === 'user') {
          const u = this.userMap.get(t.mention.user.id);
          return u ? `@[${u.name}](${u.id})` : `@${t.mention.user.name ?? this.userName(t.mention.user.id)}`;
        }
        if (t.type === 'mention' && t.mention?.type === 'page') {
          const p = this.atrium.get(t.mention.page.id);
          return p ? `${p.title || 'page'} (/p/${p.id})` : t.plain_text;
        }
        return t.plain_text ?? '';
      })
      .join('');
  }

  private async importComments(nid: string) {
    const atriumPage = this.atrium.get(nid)!.id;
    // Page-level discussions (block-level ones are fetched during discovery when includeInlineComments is on).
    const all: any[] = await this.client.comments(nid);
    const byDiscussion = new Map<string, any[]>();
    for (const c of all) {
      const k = c.discussion_id ?? c.id;
      if (!byDiscussion.has(k)) byDiscussion.set(k, []);
      if (!byDiscussion.get(k)!.some((x) => x.id === c.id)) byDiscussion.get(k)!.push(c);
    }
    for (const [discussion, comments] of byDiscussion) {
      const first = comments[0];
      const blockId = first?.parent?.type === 'block_id' ? first.parent.block_id : null;
      await this.importDiscussion(atriumPage, discussion, comments, blockId);
    }
  }

  /** One Notion discussion → one Atrium thread (idempotent across re-runs). Returns the thread id. */
  private async importDiscussion(atriumPage: string, discussion: string, comments: any[], blockId: string | null): Promise<string | null> {
    if (!comments.length) return null;
    comments.sort((a, b) => a.created_time.localeCompare(b.created_time));
    const first = comments[0];
    let thread = await one<{ atrium_id: string }>(
      `select m.atrium_id from import_mappings m join comment_threads t on t.id = m.atrium_id where m.source = 'notion-thread' and m.source_id = $1`,
      [discussion],
    );
    if (!thread) {
      const authorId = this.userMap.get(first.created_by?.id)?.id ?? null;
      const t = await one<{ id: string }>(
        `insert into comment_threads(page_id, block_id, quote, created_by, created_at) values ($1,$2,$3,$4,$5) returning id`,
        [atriumPage, blockId, blockId ? this.blockQuote(blockId) : null, authorId, first.created_time],
      );
      await q(
        `insert into import_mappings(source, source_id, atrium_id, kind, job_id) values ('notion-thread',$1,$2,'thread',$3)
         on conflict (source, source_id) do update set atrium_id = excluded.atrium_id, updated_at = now()`,
        [discussion, t!.id, this.jobId],
      );
      thread = { atrium_id: t!.id };
    }
    for (const c of comments) {
      const seen = await one(`select 1 from import_mappings where source = 'notion-comment' and source_id = $1`, [c.id]);
      if (seen) continue;
      const author = this.userMap.get(c.created_by?.id);
      const name = c.display_name?.resolved_name ?? this.userName(c.created_by?.id);
      const body = (author ? '' : `${name}: `) + this.commentBody(c.rich_text);
      const row = await one<{ id: string }>(
        `insert into comments(thread_id, author_id, body, created_at) values ($1,$2,$3,$4) returning id`,
        [thread.atrium_id, author?.id ?? null, body || '(empty comment)', c.created_time],
      );
      await q(
        `insert into import_mappings(source, source_id, atrium_id, kind, job_id) values ('notion-comment',$1,$2,'comment',$3) on conflict do nothing`,
        [c.id, row!.id, this.jobId],
      );
      this.counts.comments++;
    }
    return thread.atrium_id;
  }

  private blockQuote(blockId: string): string | null {
    for (const list of this.children.values()) {
      const b = list.find((x) => x.id === blockId);
      if (b) return plain(b[b.type]?.rich_text).slice(0, 300) || null;
    }
    return null;
  }

  report(startedAt: number) {
    return {
      counts: this.counts,
      summary: this.summary(),
      roots: this.roots,
      warnings: this.warnings,
      warningCounts: this.warningCounts,
      warningsTruncated: Object.values(this.warningCounts).reduce((a, b) => a + b, 0) > this.warnings.length,
      requests: this.client.requests,
      rateLimited: this.client.rateLimited,
      census: this.census,
      teamspaces: this.teamspaceIds,
      privateOwners: this.privateOwners,
      unresolvedTargets: [...this.unresolved.keys()].filter((t) => !this.atrium.has(t) && !this.items.has(t)).slice(0, 500),
      durationMs: Date.now() - startedAt,
    };
  }
}

/** The parser speaks of "this workspace"; during an import it means "not part of this import (yet)". */
function importWording(w: string): string {
  return w
    .replace(/is outside this workspace; kept as a link/g, 'was not part of this import; kept as a link to Notion (re-linked automatically if imported later)')
    .replace(/Mention of a page outside this workspace/g, 'Mention of a page that was not part of this import');
}

/** Groups rich-markdown parser warnings into report categories. */
function markdownWarnKind(w: string): string {
  if (/outside this workspace|isn't in this workspace|not in this workspace/i.test(w)) return 'link_unresolved';
  if (/Unsupported block/i.test(w)) return 'unsupported_block';
  if (/isn't supported/i.test(w)) return 'unsupported_container';
  if (/Synced block/i.test(w)) return 'synced_block';
  if (/file|re-upload/i.test(w)) return 'file';
  if (/date/i.test(w)) return 'date';
  return 'markdown';
}

export { richText };
