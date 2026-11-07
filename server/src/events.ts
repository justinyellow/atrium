import type { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { newRedis, redis, redisEnabled } from './redis.js';

/**
 * Lightweight invalidation bus. Events carry only ids, never content —
 * clients refetch through the permission-checked API.
 * With REDIS_URL set, events fan out to every instance via Redis pub/sub.
 */
export type AppEvent =
  | { type: 'tree' }
  | { type: 'page'; id: string }
  | { type: 'db'; id: string }
  | { type: 'comments'; pageId: string }
  | { type: 'notifications'; userId: string }
  | { type: 'members' };

const CHANNEL = 'atrium:events';
const INSTANCE = randomUUID();
const clients = new Map<WebSocket, { userId: string }>();

export function addClient(ws: WebSocket, userId: string) {
  clients.set(ws, { userId });
  ws.on('close', () => clients.delete(ws));
}

function deliver(ev: AppEvent) {
  const msg = JSON.stringify(ev);
  for (const [ws, c] of clients) {
    if (ev.type === 'notifications' && c.userId !== ev.userId) continue;
    if (ws.readyState === 1) ws.send(msg);
  }
}

let subscribed = false;
function ensureSubscribed() {
  if (subscribed || !redisEnabled()) return;
  subscribed = true;
  const sub = newRedis();
  sub.subscribe(CHANNEL).catch((e) => console.error(JSON.stringify({ level: 'error', msg: 'redis subscribe failed', err: e.message })));
  sub.on('message', (_ch, raw) => {
    try {
      const { from, ev } = JSON.parse(raw);
      if (from !== INSTANCE) deliver(ev);
    } catch {}
  });
}

export function emit(ev: AppEvent) {
  deliver(ev);
  if (redisEnabled()) {
    ensureSubscribed();
    redis().publish(CHANNEL, JSON.stringify({ from: INSTANCE, ev })).catch(() => {});
  }
}

/** Call at boot so this instance receives events published by others before it emits any. */
export function startEventBus() {
  ensureSubscribed();
}

export function closeEventClients() {
  for (const ws of clients.keys()) ws.close(1001, 'server shutting down');
}
