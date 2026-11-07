/**
 * Email: drivers (log | ses | smtp), a Postgres outbox drained by a leader-only worker,
 * notification emails with per-user preferences, and the daily digest.
 *
 * Nothing on the request path talks to a mail server: sendEmail() only enqueues.
 * The worker runs on the instance holding the jobs advisory lock, so multi-task ECS
 * deployments send each message once.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { one, q, runAsLeader } from './db.js';
import { digestEmail, notificationEmail, type NotifInfo, type NotifType, type Rendered } from './emailTemplates.js';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

// ---------------------------------------------------------------- drivers

interface Outgoing extends EmailMessage {
  headers?: Record<string, string>;
}

class PermanentEmailError extends Error {}

type Driver = (m: Outgoing) => Promise<void>;
let driver: Driver | null = null;

async function getDriver(): Promise<Driver> {
  if (driver) return driver;
  const c = config.email;
  if (c.driver === 'ses') {
    const { SESv2Client, SendEmailCommand } = await import('@aws-sdk/client-sesv2');
    const client = new SESv2Client({ region: c.sesRegion }); // default credential chain → ECS task role
    driver = async (m) => {
      try {
        await client.send(
          new SendEmailCommand({
            FromEmailAddress: c.from,
            Destination: { ToAddresses: [m.to] },
            ConfigurationSetName: c.sesConfigurationSet,
            Content: {
              Simple: {
                Subject: { Data: m.subject, Charset: 'UTF-8' },
                Body: { Text: { Data: m.text, Charset: 'UTF-8' }, ...(m.html ? { Html: { Data: m.html, Charset: 'UTF-8' } } : {}) },
                Headers: Object.entries(m.headers ?? {}).map(([Name, Value]) => ({ Name, Value })),
              },
            },
          }),
        );
      } catch (e: any) {
        // Rejections / unverified identities won't succeed on retry.
        if (['MessageRejected', 'MailFromDomainNotVerifiedException', 'AccountSuspendedException', 'SendingPausedException', 'BadRequestException', 'NotFoundException'].includes(e?.name))
          throw new PermanentEmailError(`${e.name}: ${e.message}`);
        throw e;
      }
    };
  } else if (c.driver === 'smtp') {
    const nodemailer = (await import('nodemailer')).default;
    const transport = nodemailer.createTransport({
      host: c.smtpHost,
      port: c.smtpPort,
      secure: c.smtpSecure,
      auth: c.smtpUser ? { user: c.smtpUser, pass: c.smtpPass } : undefined,
    });
    driver = async (m) => {
      try {
        await transport.sendMail({ from: c.from, to: m.to, subject: m.subject, text: m.text, html: m.html, headers: m.headers });
      } catch (e: any) {
        if (typeof e?.responseCode === 'number' && e.responseCode >= 500) throw new PermanentEmailError(`SMTP ${e.responseCode}: ${e.message}`);
        throw e;
      }
    };
  } else {
    driver = async (m) => {
      console.log(JSON.stringify({ level: 'info', msg: 'email (log driver)', to: m.to, subject: m.subject, text: m.text }));
    };
  }
  return driver;
}

// ---------------------------------------------------------------- helpers

export function publicBase(): string {
  return config.publicUrl ?? `http://localhost:${config.port}`;
}

let wsName: { name: string; at: number } | null = null;
export async function workspaceName(): Promise<string> {
  if (wsName && Date.now() - wsName.at < 60_000) return wsName.name;
  const r = await one<{ name: string }>('select name from workspaces order by created_at limit 1');
  wsName = { name: r?.name ?? 'Atrium', at: Date.now() };
  return wsName.name;
}

let signingSecret: string | null = null;
async function secret(): Promise<string> {
  if (signingSecret) return signingSecret;
  // Shared across instances: generated once, stored in Postgres.
  await q(`insert into app_secrets(name, value) values ('email_signing', $1) on conflict (name) do nothing`, [randomBytes(32).toString('base64url')]);
  signingSecret = (await one<{ value: string }>(`select value from app_secrets where name = 'email_signing'`))!.value;
  return signingSecret;
}

async function sign(payload: string) {
  return createHmac('sha256', await secret()).update(payload).digest('base64url');
}

export async function verifySignature(payload: string, sig: string) {
  const expected = Buffer.from(await sign(payload));
  const got = Buffer.from(sig ?? '');
  return expected.length === got.length && timingSafeEqual(expected, got);
}

// ---------------------------------------------------------------- outbox

export async function enqueue(
  to: string,
  r: Rendered | EmailMessage,
  opts: { kind?: string; notificationId?: string | null; delaySeconds?: number; headers?: Record<string, string> } = {},
) {
  await q(
    `insert into email_outbox(to_addr, subject, text_body, html_body, headers, kind, notification_id, send_after)
     values ($1,$2,$3,$4,$5,$6,$7, now() + make_interval(secs => $8))`,
    [to, r.subject, r.text, r.html ?? null, opts.headers ?? {}, opts.kind ?? 'generic', opts.notificationId ?? null, opts.delaySeconds ?? 0],
  );
}

/** Public contract: enqueue for delivery. Never throws; true when accepted. */
export async function sendEmail(msg: EmailMessage): Promise<boolean> {
  try {
    if (!msg.to || !/^[^@\s]+@[^@\s]+$/.test(msg.to)) return false;
    await enqueue(msg.to, msg);
    return true;
  } catch (e: any) {
    console.error(JSON.stringify({ level: 'error', msg: 'email enqueue failed', err: e.message }));
    return false;
  }
}

const MAX_ATTEMPTS = 6;

export async function processOutbox(limit = 20) {
  // Recover rows stranded by a crash mid-send.
  await q(`update email_outbox set status = 'pending' where status = 'sending' and send_after < now() - interval '10 minutes'`);
  const rows = await q(
    `update email_outbox set status = 'sending', attempts = attempts + 1 where id in (
       select id from email_outbox where status = 'pending' and send_after <= now() order by send_after, id limit $1 for update skip locked
     ) returning *`,
    [limit],
  );
  if (!rows.length) return 0;
  const send = await getDriver();
  for (const m of rows) {
    // Notification emails: skip if the user read it meanwhile, opted out, or was deactivated.
    if (m.notification_id) {
      const n = await one(
        `select n.read_at, n.archived, n.type, n.user_id, u.active from notifications n join users u on u.id = n.user_id where n.id = $1`,
        [m.notification_id],
      );
      const mode = n ? (await getPrefs(n.user_id))[prefKey(n.type)] : 'off';
      if (!n || n.read_at || n.archived || !n.active || mode !== 'immediate') {
        await q(`update email_outbox set status = 'skipped', last_error = $2 where id = $1`, [m.id, !n ? 'notification deleted' : n.read_at ? 'already read' : 'not wanted']);
        continue;
      }
    }
    try {
      await send({ to: m.to_addr, subject: m.subject, text: m.text_body, html: m.html_body ?? undefined, headers: m.headers });
      await q(`update email_outbox set status = 'sent', sent_at = now(), last_error = null where id = $1`, [m.id]);
    } catch (e: any) {
      const permanent = e instanceof PermanentEmailError || m.attempts >= MAX_ATTEMPTS;
      const backoff = Math.min(30 * 2 ** (m.attempts - 1), 3600);
      await q(
        `update email_outbox set status = $2, last_error = $3, send_after = now() + make_interval(secs => $4) where id = $1`,
        [m.id, permanent ? 'failed' : 'pending', String(e?.message || e?.code || e).slice(0, 500), backoff],
      );
      console.error(JSON.stringify({ level: 'warn', msg: 'email send failed', id: m.id, attempt: m.attempts, permanent, err: String(e?.message || e?.code || e) }));
    }
  }
  // Keep the table small.
  q(`delete from email_outbox where status in ('sent','skipped') and created_at < now() - interval '30 days'`).catch(() => {});
  return rows.length;
}

// ---------------------------------------------------------------- preferences

export type PrefKey = 'mention' | 'comment' | 'share' | 'assigned' | 'reminder';
export type PrefMode = 'immediate' | 'digest' | 'off';
export const PREF_KEYS: PrefKey[] = ['mention', 'comment', 'share', 'assigned', 'reminder'];
export const PREF_LABELS: Record<PrefKey, string> = {
  mention: 'mention', comment: 'comment and reply', share: 'page shared', assigned: 'assignment', reminder: 'reminder',
};
export const DEFAULT_PREFS: Record<PrefKey, PrefMode> = {
  mention: 'immediate', comment: 'digest', share: 'immediate', assigned: 'immediate', reminder: 'immediate',
};

export const prefKey = (type: string): PrefKey => (type === 'reply' ? 'comment' : (type as PrefKey));

export async function getPrefs(userId: string): Promise<Record<PrefKey, PrefMode>> {
  const r = await one<{ prefs: Record<string, string> }>('select prefs from notification_prefs where user_id = $1', [userId]);
  const out = { ...DEFAULT_PREFS };
  for (const k of PREF_KEYS) {
    const v = r?.prefs?.[k];
    if (v === 'immediate' || v === 'digest' || v === 'off') out[k] = v;
  }
  return out;
}

export async function setPrefs(userId: string, patch: Partial<Record<PrefKey, PrefMode>>) {
  const clean: Record<string, PrefMode> = {};
  for (const k of PREF_KEYS) {
    const v = patch[k];
    if (v === 'immediate' || v === 'digest' || v === 'off') clean[k] = v;
  }
  await q(
    `insert into notification_prefs(user_id, prefs) values ($1, $2)
     on conflict (user_id) do update set prefs = notification_prefs.prefs || excluded.prefs`,
    [userId, clean],
  );
  return getPrefs(userId);
}

/** Signed one-click unsubscribe link. `key` is a PrefKey or 'digest' (turns every digest type off). */
export async function unsubscribeUrl(userId: string, key: PrefKey | 'digest') {
  const s = await sign(`${userId}:${key}`);
  return `${publicBase()}/api/v1/email/unsubscribe?u=${userId}&k=${key}&s=${s}`;
}

// ---------------------------------------------------------------- notification emails

function notifInfo(n: any): NotifInfo {
  return {
    type: n.type as NotifType,
    actor: n.actor_name ?? null,
    pageTitle: n.page_title ?? null,
    pageUrl: n.page_id ? `${publicBase()}/p/${n.page_id}` : `${publicBase()}/`,
    body: n.data?.body ?? null,
    level: n.data?.level ?? null,
    date: n.data?.date ?? null,
  };
}

const NOTIF_SQL = `select n.id, n.type, n.page_id, n.data, n.created_at, a.name as actor_name, p.title as page_title,
    u.id as user_id, u.email, u.name as user_name, u.active
  from notifications n join users u on u.id = n.user_id
  left join users a on a.id = n.actor_id left join pages p on p.id = n.page_id`;

/** Called right after a notification row is created. Never throws. */
export async function queueNotificationEmail(notificationId: string) {
  try {
    const n = await one(`${NOTIF_SQL} where n.id = $1`, [notificationId]);
    if (!n || !n.active || !n.email) return;
    const key = prefKey(n.type);
    if (!PREF_KEYS.includes(key)) return;
    const prefs = await getPrefs(n.user_id);
    if (prefs[key] !== 'immediate') return; // digest/off handled elsewhere
    const unsub = await unsubscribeUrl(n.user_id, key);
    const r = notificationEmail({ workspace: await workspaceName(), n: notifInfo(n), unsubscribeUrl: unsub, typeLabel: PREF_LABELS[key] });
    await enqueue(n.email, r, {
      kind: `notification.${n.type}`,
      notificationId,
      delaySeconds: config.email.notificationDelaySeconds,
      headers: { 'List-Unsubscribe': `<${unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
    });
  } catch (e: any) {
    console.error(JSON.stringify({ level: 'error', msg: 'notification email failed', err: e.message }));
  }
}

// ---------------------------------------------------------------- digest

function digestDue(now: Date, last: Date | null) {
  const slot = new Date(now);
  slot.setHours(config.email.digestHour, 0, 0, 0);
  if (now < slot) slot.setDate(slot.getDate() - 1); // most recent digest slot
  return !last || new Date(last) < slot;
}

/** Send daily digests that are due. `force` ignores the schedule (admin/testing). Returns emails queued. */
export async function runDigests(opts: { force?: boolean; userId?: string } = {}) {
  const users = await q(
    `select u.id, u.email, u.name, np.last_digest_at from users u
     join workspace_members m on m.user_id = u.id left join notification_prefs np on np.user_id = u.id
     where u.active ${opts.userId ? 'and u.id = $1' : ''}`,
    opts.userId ? [opts.userId] : [],
  );
  const now = new Date();
  let queued = 0;
  for (const u of users) {
    if (!opts.force && !digestDue(now, u.last_digest_at)) continue;
    const prefs = await getPrefs(u.id);
    const digestTypes = PREF_KEYS.filter((k) => prefs[k] === 'digest').flatMap((k) => (k === 'comment' ? ['comment', 'reply'] : [k]));
    if (digestTypes.length && u.email) {
      const since = u.last_digest_at ?? new Date(now.getTime() - 86400_000);
      const items = await q(
        `${NOTIF_SQL} where n.user_id = $1 and n.read_at is null and not n.archived and n.type = any($2::text[])
           and n.created_at > $3 and (p.id is null or p.deleted_at is null) order by n.created_at desc limit 100`,
        [u.id, digestTypes, since],
      );
      if (items.length) {
        const unsub = await unsubscribeUrl(u.id, 'digest');
        const r = digestEmail({
          workspace: await workspaceName(),
          name: u.name,
          items: items.map(notifInfo),
          inboxUrl: `${publicBase()}/`,
          settingsUrl: `${publicBase()}/?settings=notifications`,
          unsubscribeUrl: unsub,
        });
        await enqueue(u.email, r, { kind: 'digest', headers: { 'List-Unsubscribe': `<${unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } });
        queued++;
      }
    }
    await q(
      `insert into notification_prefs(user_id, last_digest_at) values ($1, now())
       on conflict (user_id) do update set last_digest_at = now()`,
      [u.id],
    );
  }
  return queued;
}

// ---------------------------------------------------------------- worker

let timers: ReturnType<typeof setInterval>[] = [];
export function startEmailWorker() {
  if (timers.length) return;
  timers.push(setInterval(() => runAsLeader(async () => { await processOutbox(); }), 10_000));
  timers.push(setInterval(() => runAsLeader(async () => { await runDigests(); }), 5 * 60_000));
}
export function stopEmailWorker() {
  timers.forEach(clearInterval);
  timers = [];
}
