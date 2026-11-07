import { Redis as IORedis } from 'ioredis';
import { config } from './config.js';

/** Lazily-created Redis connections (only when REDIS_URL is set). */
const clients: IORedis[] = [];

export function redisEnabled() {
  return !!config.redisUrl;
}

export function newRedis(): IORedis {
  const c = new IORedis(config.redisUrl!, { maxRetriesPerRequest: null, enableReadyCheck: true });
  c.on('error', (e) => console.error(JSON.stringify({ level: 'error', msg: 'redis error', err: e.message })));
  clients.push(c);
  return c;
}

let shared: IORedis | null = null;
export function redis(): IORedis {
  shared ??= newRedis();
  return shared;
}

export async function closeRedis() {
  await Promise.all(clients.map((c) => c.quit().catch(() => c.disconnect())));
}
