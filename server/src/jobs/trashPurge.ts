import type { FastifyInstance } from 'fastify';
import { q, runAsLeader } from '../db.js';
import { config } from '../config.js';
import { audit } from '../audit.js';

/**
 * Permanently delete pages that have been in the trash longer than `days`.
 * Only trash *roots* are deleted; their sub-pages cascade (pages.parent_id on delete cascade).
 */
export async function purgeTrash(days: number) {
  if (!days || days <= 0) return { purged: 0, retentionDays: days, skipped: true };
  const rows = await q<{ id: string; title: string; kind: string }>(
    `delete from pages p
     where p.deleted_at is not null and p.deleted_at < now() - ($1 || ' days')::interval
       and (p.parent_id is null or not exists (select 1 from pages pp where pp.id = p.parent_id and pp.deleted_at is not null))
     returning id, title, kind`,
    [String(days)],
  );
  return { purged: rows.length, retentionDays: days, pages: rows.slice(0, 50).map((r) => ({ id: r.id, title: r.title, kind: r.kind })) };
}

/** Hourly, on the jobs-lock holder only (same leader election as reminders). */
export function startTrashPurge(app: FastifyInstance) {
  const tick = () =>
    runAsLeader(async () => {
      const r = await purgeTrash(config.trashRetentionDays);
      if (r.purged) await audit({ action: 'trash.purged', targetType: 'workspace', meta: { purged: r.purged, retentionDays: r.retentionDays, pages: r.pages } });
    });
  const first = setTimeout(tick, 60_000);
  const timer = setInterval(tick, 60 * 60_000);
  app.addHook('onClose', async () => {
    clearTimeout(first);
    clearInterval(timer);
  });
}
