import { q } from './db.js';
import { emit } from './events.js';
import { queueNotificationEmail } from './email.js';

export async function notify(
  userId: string,
  type: 'mention' | 'comment' | 'reply' | 'share' | 'assigned' | 'reminder',
  actorId: string | null,
  pageId: string | null,
  data: Record<string, unknown>,
) {
  if (userId === actorId) return;
  const [row] = await q<{ id: string }>(
    'insert into notifications(user_id, type, actor_id, page_id, data) values ($1,$2,$3,$4,$5) returning id',
    [userId, type, actorId, pageId, data],
  );
  emit({ type: 'notifications', userId });
  // Email per the user's preferences (immediate sends are delayed and skipped if read meanwhile).
  if (row) await queueNotificationEmail(row.id);
}
