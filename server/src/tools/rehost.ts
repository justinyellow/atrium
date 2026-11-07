import { call, type ToolCtx } from './context.js';

/**
 * Copy remote images/files referenced in Markdown into Atrium storage and rewrite the references,
 * so content doesn't break when the source URL expires (Notion's signed file URLs last about an hour).
 * Handles ![alt](url), <img src>, Notion-flavoured <image|file|video|audio|pdf source|src="…"> and
 * plain links to signed S3 objects. Already-hosted Atrium URLs are left alone.
 */
const IMG_MD = /!\[([^\]]*)\]\((\s*<?)(https?:\/\/[^)\s>]+)(>?\s*(?:"[^"]*")?\s*)\)/g;
const TAG_SRC = /(<(?:img|image|file|video|audio|pdf)\b[^>]*?\b(?:src|source)=")(https?:\/\/[^"]+)(")/gi;
const SIGNED_LINK = /(\]\()(https?:\/\/[^)\s]*(?:X-Amz-Signature|x-amz-signature|Signature=)[^)\s]*)(\))/g;

export async function rehostUrl(ctx: ToolCtx, url: string, pageId?: string | null): Promise<string> {
  if (!/^https?:\/\//i.test(url)) return url;
  if (url.includes('/api/v1/files/')) return url;
  const f = await call<{ url: string }>(ctx, 'POST', '/files/from-url', { url, ...(pageId ? { pageId } : {}) });
  return f.url;
}

export async function rehostMarkdown(ctx: ToolCtx, md: string, pageId?: string | null): Promise<{ markdown: string; rehosted: number; failed: string[] }> {
  const urls = new Set<string>();
  for (const re of [IMG_MD, TAG_SRC, SIGNED_LINK]) {
    re.lastIndex = 0;
    for (const m of md.matchAll(re)) urls.add(re === IMG_MD ? m[3] : m[2]);
  }
  const map = new Map<string, string>();
  const failed: string[] = [];
  for (const u of urls) {
    try {
      map.set(u, await rehostUrl(ctx, u, pageId));
    } catch {
      failed.push(u);
    }
  }
  const swap = (u: string) => map.get(u) ?? u;
  const out = md
    .replace(IMG_MD, (_m, alt, pre, u, post) => `![${alt}](${pre}${swap(u)}${post})`)
    .replace(TAG_SRC, (_m, pre, u, post) => `${pre}${swap(u)}${post}`)
    .replace(SIGNED_LINK, (_m, pre, u, post) => `${pre}${swap(u)}${post}`);
  return { markdown: out, rehosted: [...map.entries()].filter(([a, b]) => a !== b).length, failed };
}
