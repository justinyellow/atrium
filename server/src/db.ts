import pg from 'pg';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config } from './config.js';

export const pool = new pg.Pool({
  connectionString: config.db.url,
  max: config.db.poolMax,
  ssl: config.db.ssl ? { rejectUnauthorized: config.db.sslRejectUnauthorized } : undefined,
});
pool.on('error', (e) => console.error(JSON.stringify({ level: 'error', msg: 'pg pool error', err: e.message })));

export async function q<T = any>(sql: string, params: any[] = []): Promise<T[]> {
  const r = await pool.query(sql, params);
  return r.rows as T[];
}

export async function one<T = any>(sql: string, params: any[] = []): Promise<T | undefined> {
  return (await q<T>(sql, params))[0];
}

export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('begin');
    const r = await fn(c);
    await c.query('commit');
    return r;
  } catch (e) {
    await c.query('rollback');
    throw e;
  } finally {
    c.release();
  }
}

// Advisory lock keys (arbitrary but stable int64s).
export const LOCK = { migrate: 724_100_001, jobs: 724_100_002 } as const;

/** Schema migration on boot. Serialised with an advisory lock so concurrent ECS tasks don't race. */
export async function migrate() {
  const dir = dirname(fileURLToPath(import.meta.url));
  const sql = readFileSync(join(dir, 'schema.sql'), 'utf8');
  const c = await pool.connect();
  try {
    await c.query('select pg_advisory_lock($1)', [LOCK.migrate]);
    await c.query(sql);
  } finally {
    await c.query('select pg_advisory_unlock($1)', [LOCK.migrate]).catch(() => {});
    c.release();
  }
}

/**
 * Runs `fn` only on the instance holding the jobs lock (leader election via a session
 * advisory lock on a dedicated connection). If the leader dies its connection drops and
 * another task takes over on its next tick. No Redis required.
 */
let leaderClient: pg.PoolClient | null = null;
export async function runAsLeader(fn: () => Promise<void>) {
  try {
    if (!leaderClient) {
      const c = await pool.connect();
      const r = await c.query('select pg_try_advisory_lock($1) as ok', [LOCK.jobs]);
      if (!r.rows[0].ok) {
        c.release();
        return;
      }
      c.on('error', () => {
        leaderClient = null;
      });
      leaderClient = c;
    }
    await fn();
  } catch (e: any) {
    console.error(JSON.stringify({ level: 'error', msg: 'background job failed', err: e.message }));
  }
}

export async function closeDb() {
  if (leaderClient) {
    await leaderClient.query('select pg_advisory_unlock($1)', [LOCK.jobs]).catch(() => {});
    leaderClient.release();
    leaderClient = null;
  }
  await pool.end();
}
