/**
 * Minimal typed client for the official Notion REST API (api.notion.com).
 * Throttled (~3 req/s, Notion's documented average), retries 429/5xx with Retry-After, paginates, times out.
 */

export const NOTION_API_BASE = 'https://api.notion.com/v1';
export const NOTION_VERSION = process.env.NOTION_API_VERSION || '2026-03-11';

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<any>;
  text(): Promise<string>;
}>;

export class NotionApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export interface NotionClientOptions {
  token: string;
  fetchImpl?: FetchLike;
  minIntervalMs?: number;
  /** Requests allowed back-to-back before the average rate applies. */
  burst?: number;
  maxRetries?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export class NotionClient {
  private fetchImpl: FetchLike;
  requests = 0;
  /** Requests that hit 429 (rate limited) — reported so imports can be tuned. */
  rateLimited = 0;
  // Token bucket shared by every concurrent request of this client: Notion allows an average of
  // ~3 requests/second with short bursts. `pausedUntil` is set by a 429's Retry-After so all
  // in-flight workers back off together instead of hammering the API.
  private tokens: number;
  private lastRefill = Date.now();
  private pausedUntil = 0;
  private rate: number;
  private burst: number;

  constructor(private opts: NotionClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as any);
    this.rate = 1000 / (opts.minIntervalMs ?? 340); // tokens per second
    this.burst = opts.burst ?? 6;
    this.tokens = this.burst;
  }

  private async throttle() {
    if (!Number.isFinite(this.rate)) {
      // No rate limit configured (tests): only honour a 429 pause.
      const wait = this.pausedUntil - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      return;
    }
    for (;;) {
      const now = Date.now();
      if (now < this.pausedUntil) {
        await new Promise((r) => setTimeout(r, this.pausedUntil - now));
        continue;
      }
      this.tokens = Math.min(this.burst, this.tokens + ((now - this.lastRefill) / 1000) * this.rate);
      this.lastRefill = now;
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await new Promise((r) => setTimeout(r, Math.max(5, ((1 - this.tokens) / this.rate) * 1000)));
    }
  }

  async request<T = any>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const maxRetries = this.opts.maxRetries ?? 5;
    for (let attempt = 0; ; attempt++) {
      if (this.opts.signal?.aborted) throw new NotionApiError(0, 'cancelled', 'Import cancelled');
      await this.throttle();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs ?? 30_000);
      let res;
      try {
        this.requests++;
        res = await this.fetchImpl(`${NOTION_API_BASE}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${this.opts.token}`,
            'Notion-Version': NOTION_VERSION,
            'Content-Type': 'application/json',
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: ctrl.signal,
        });
      } catch (e: any) {
        clearTimeout(timer);
        if (attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** attempt, 15_000)));
          continue;
        }
        throw new NotionApiError(0, 'network_error', `Notion request failed: ${e.message}`);
      }
      clearTimeout(timer);
      if (res.ok) return (await res.json()) as T;
      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt < maxRetries) {
        const ra = Number(res.headers.get('retry-after'));
        const delay = Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(1000 * 2 ** attempt, 15_000);
        if (res.status === 429) {
          this.rateLimited++;
          this.pausedUntil = Math.max(this.pausedUntil, Date.now() + delay);
          this.tokens = 0;
        }
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      let err: any = {};
      try {
        err = await res.json();
      } catch {}
      throw new NotionApiError(res.status, err.code ?? 'error', err.message ?? `Notion API ${res.status} on ${method} ${path}`);
    }
  }

  /** Iterates every page of a cursor-paginated endpoint. */
  async paginate<T = any>(method: 'GET' | 'POST', path: string, body: Record<string, unknown> = {}, limit = Infinity): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | undefined;
    do {
      let res: any;
      if (method === 'GET') {
        const sep = path.includes('?') ? '&' : '?';
        res = await this.request('GET', `${path}${sep}page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ''}`);
      } else {
        res = await this.request('POST', path, { ...body, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
      }
      out.push(...(res.results ?? []));
      cursor = res.has_more ? res.next_cursor ?? undefined : undefined;
    } while (cursor && out.length < limit);
    return out.slice(0, limit);
  }

  me() {
    return this.request('GET', '/users/me');
  }
  users() {
    return this.paginate('GET', '/users');
  }
  search(objectType: 'page' | 'data_source') {
    return this.paginate('POST', '/search', { filter: { property: 'object', value: objectType } });
  }
  page(id: string) {
    return this.request('GET', `/pages/${id}`);
  }
  pageProperty(pageId: string, propId: string) {
    return this.paginate('GET', `/pages/${pageId}/properties/${encodeURIComponent(propId)}`);
  }
  blockChildren(id: string) {
    return this.paginate('GET', `/blocks/${id}/children`);
  }
  database(id: string) {
    return this.request('GET', `/databases/${id}`);
  }
  dataSource(id: string) {
    return this.request('GET', `/data_sources/${id}`);
  }
  /** Rows of a data source; `limit` stops paging early (trial imports). */
  queryDataSource(id: string, limit = Infinity) {
    return this.paginate('POST', `/data_sources/${id}/query`, {}, limit);
  }
  async dataSourceTemplates(id: string): Promise<any[]> {
    const r = await this.request('GET', `/data_sources/${id}/templates`);
    return r.templates ?? r.results ?? [];
  }
  async views(databaseId: string): Promise<any[]> {
    const list = await this.paginate('GET', `/views?database_id=${databaseId}`);
    const out = [];
    for (const v of list) {
      if (v.type && (v.filter !== undefined || v.configuration !== undefined)) {
        out.push(v);
        continue;
      }
      try {
        out.push(await this.request('GET', `/views/${v.id}`));
      } catch (e: any) {
        // Some view types (e.g. "feed") can't be read through the API: keep a stub so the other views still import.
        const type = String(e?.message ?? '').match(/view type:\s*([\w-]+)/i)?.[1] ?? v.type ?? 'unknown';
        out.push({ id: v.id, name: v.name, type, _unreadable: String(e?.message ?? e) });
      }
    }
    return out;
  }
  comments(blockId: string) {
    return this.paginate('GET', `/comments?block_id=${blockId}`);
  }
  /**
   * Whole page as Notion-flavored Markdown in one request (vs one request per block with children).
   * `truncated` / `unknown_block_ids` tell the caller to fall back to the block tree.
   */
  pageMarkdown(id: string): Promise<{ markdown: string; truncated?: boolean; unknown_block_ids?: string[] }> {
    return this.request('GET', `/pages/${id}/markdown`);
  }
}

/** Runs `fn` over `items` with at most `limit` in flight (the client's token bucket still caps the rate). */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

/** Accepts a Notion URL or id (with/without dashes) and returns a dashed UUID. */
export function normalizeNotionId(input: string): string | null {
  const m = input.replace(/-/g, '').match(/([0-9a-f]{32})(?:[?#].*)?$/i) ?? input.replace(/-/g, '').match(/([0-9a-f]{32})/i);
  if (!m) return null;
  const h = m[1].toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
