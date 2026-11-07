/** Email templates: every message has a text and a responsive HTML version. */

export interface Rendered {
  subject: string;
  text: string;
  html: string;
}

export const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

interface Layout {
  workspace: string;
  heading: string;
  paragraphs: string[]; // already-escaped HTML fragments
  quote?: string | null; // plain text, escaped here
  extraHtml?: string; // trusted block HTML rendered after paragraphs
  cta?: { label: string; url: string } | null;
  footer?: string; // escaped HTML
  unsubscribeUrl?: string | null;
}

function layout(l: Layout): string {
  const quote = l.quote
    ? `<div style="margin:16px 0;padding:10px 14px;border-left:3px solid #e9e9e7;color:#37352f;background:#f7f7f5;border-radius:4px;white-space:pre-wrap">${esc(l.quote)}</div>`
    : '';
  const cta = l.cta
    ? `<table role="presentation" cellspacing="0" cellpadding="0" style="margin:24px 0"><tr><td style="border-radius:6px;background:#2383e2">
         <a href="${esc(l.cta.url)}" style="display:inline-block;padding:10px 18px;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px">${esc(l.cta.label)}</a>
       </td></tr></table>`
    : '';
  const unsub = l.unsubscribeUrl
    ? `<br><a href="${esc(l.unsubscribeUrl)}" style="color:#9b9a97">Unsubscribe from these emails</a>`
    : '';
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(l.heading)}</title></head>
<body style="margin:0;padding:0;background:#f7f7f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#37352f">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f7f7f5;padding:24px 12px">
<tr><td align="center">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#ffffff;border-radius:10px;border:1px solid #e9e9e7">
    <tr><td style="padding:18px 24px;border-bottom:1px solid #f1f1ef;font-weight:600;font-size:14px">
      <span style="display:inline-block;width:22px;height:22px;line-height:22px;text-align:center;border-radius:5px;background:#191919;color:#fff;font-family:Georgia,serif;margin-right:8px">A</span>${esc(l.workspace)}
    </td></tr>
    <tr><td style="padding:24px 24px 8px;font-size:15px;line-height:1.55">
      <h1 style="font-size:20px;line-height:1.3;margin:0 0 12px;font-weight:700">${esc(l.heading)}</h1>
      ${l.paragraphs.map((p) => `<p style="margin:0 0 12px">${p}</p>`).join('\n')}
      ${l.extraHtml ?? ''}${quote}${cta}
    </td></tr>
    <tr><td style="padding:12px 24px 20px;font-size:12px;color:#9b9a97;line-height:1.5">
      ${l.footer ?? `You're receiving this because you're a member of ${esc(l.workspace)} on Atrium.`}${unsub}
    </td></tr>
  </table>
</td></tr></table></body></html>`;
}

function text(parts: (string | null | undefined | false)[]) {
  return parts.filter((p) => p !== null && p !== undefined && p !== false).join('\n\n') + '\n';
}

const pageName = (t?: string | null) => (t && t.trim() ? t : 'Untitled');

// ---------- account ----------

export function inviteEmail(o: { workspace: string; inviter: string | null; role: string; url: string; expires: Date }): Rendered {
  const who = o.inviter ? `${o.inviter} invited you` : 'You have been invited';
  const role = o.role === 'guest' ? 'a guest' : o.role === 'admin' ? 'an admin' : 'a member';
  const exp = o.expires.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  return {
    subject: `${o.inviter ?? 'Someone'} invited you to ${o.workspace} on Atrium`,
    text: text([`${who} to join ${o.workspace} on Atrium as ${role}.`, `Accept the invite: ${o.url}`, `This link expires on ${exp}.`]),
    html: layout({
      workspace: o.workspace,
      heading: `Join ${o.workspace}`,
      paragraphs: [`${esc(who)} to join <b>${esc(o.workspace)}</b> on Atrium as ${esc(role)}.`, `This invite expires on ${esc(exp)}.`],
      cta: { label: 'Accept invite', url: o.url },
      footer: `If you weren't expecting this invite, you can ignore this email.`,
    }),
  };
}

export function passwordResetEmail(o: { workspace: string; name: string; url: string }): Rendered {
  return {
    subject: `Reset your ${o.workspace} password`,
    text: text([`Hi ${o.name},`, `Someone asked to reset the password for your Atrium account. Use this link within 1 hour:`, o.url, `If you didn't ask for this, you can ignore this email — your password won't change.`]),
    html: layout({
      workspace: o.workspace,
      heading: 'Reset your password',
      paragraphs: [`Hi ${esc(o.name)},`, `Someone asked to reset the password for your Atrium account. This link works once and expires in 1 hour.`],
      cta: { label: 'Choose a new password', url: o.url },
      footer: `If you didn't ask for this, you can ignore this email — your password won't change.`,
    }),
  };
}

export function passwordChangedEmail(o: { workspace: string; name: string; when: Date; url: string }): Rendered {
  const when = o.when.toUTCString();
  return {
    subject: `Your ${o.workspace} password was changed`,
    text: text([`Hi ${o.name},`, `The password for your Atrium account was changed on ${when}. All other sessions were signed out.`, `If this wasn't you, reset your password now: ${o.url} and tell a workspace admin.`]),
    html: layout({
      workspace: o.workspace,
      heading: 'Your password was changed',
      paragraphs: [`Hi ${esc(o.name)},`, `The password for your Atrium account was changed on ${esc(when)}. Other sessions were signed out.`, `If this wasn't you, reset your password straight away and tell a workspace admin.`],
      cta: { label: 'Reset password', url: o.url },
    }),
  };
}

export function testEmail(o: { workspace: string; driver: string }): Rendered {
  return {
    subject: `Atrium test email (${o.driver})`,
    text: text([`This is a test email from ${o.workspace}.`, `Driver: ${o.driver}. If you can read this, email delivery works.`]),
    html: layout({ workspace: o.workspace, heading: 'Email delivery works', paragraphs: [`This is a test email from <b>${esc(o.workspace)}</b>.`, `Driver: <code>${esc(o.driver)}</code>.`] }),
  };
}

// ---------- notifications ----------

export type NotifType = 'mention' | 'comment' | 'reply' | 'share' | 'assigned' | 'reminder';

export interface NotifInfo {
  type: NotifType;
  actor: string | null;
  pageTitle: string | null;
  pageUrl: string;
  body?: string | null; // comment text / snippet
  level?: string | null; // share level
  date?: string | null; // reminder date
}

const levelLabel: Record<string, string> = { full: 'full access', edit: 'edit access', comment: 'comment access', view: 'view access' };

/** One-line summary shared by single emails and the digest. */
export function notifSummary(n: NotifInfo): string {
  const who = n.actor ?? 'Someone';
  const page = pageName(n.pageTitle);
  switch (n.type) {
    case 'mention': return `${who} mentioned you in ${page}`;
    case 'comment': return `${who} commented on ${page}`;
    case 'reply': return `${who} replied to a discussion in ${page}`;
    case 'share': return `${who} shared ${page} with you${n.level ? ` (${levelLabel[n.level] ?? n.level})` : ''}`;
    case 'assigned': return `${who} assigned you to ${page}`;
    case 'reminder': return `Reminder: ${page}${n.date ? ` — ${n.date}` : ''}`;
  }
}

/** Strip the @[Name](uuid) mention markup used in comment bodies. */
export const plainBody = (s?: string | null) => (s ?? '').replace(/@\[([^\]]*)\]\([0-9a-f-]{36}\)/g, '@$1').trim();

export function notificationEmail(o: { workspace: string; n: NotifInfo; unsubscribeUrl: string; typeLabel: string }): Rendered {
  const summary = notifSummary(o.n);
  const body = plainBody(o.n.body);
  return {
    subject: summary,
    text: text([summary, body ? `"${body}"` : null, `Open in Atrium: ${o.n.pageUrl}`, `Turn off ${o.typeLabel} emails: ${o.unsubscribeUrl}`]),
    html: layout({
      workspace: o.workspace,
      heading: summary,
      paragraphs: [],
      quote: body || null,
      cta: { label: o.n.type === 'share' ? 'Open page' : 'View in Atrium', url: o.n.pageUrl },
      unsubscribeUrl: o.unsubscribeUrl,
      footer: `You're receiving this because of your ${esc(o.typeLabel)} email settings in ${esc(o.workspace)}.`,
    }),
  };
}

export function digestEmail(o: { workspace: string; name: string; items: NotifInfo[]; inboxUrl: string; settingsUrl: string; unsubscribeUrl: string }): Rendered {
  const n = o.items.length;
  const subject = `${n} unread update${n === 1 ? '' : 's'} in ${o.workspace}`;
  const lines = o.items.slice(0, 30).map((i) => ({ summary: notifSummary(i), body: plainBody(i.body), url: i.pageUrl }));
  const more = n > 30 ? n - 30 : 0;
  const listHtml = `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:8px 0 4px">${lines
    .map(
      (l) => `<tr><td style="padding:10px 0;border-bottom:1px solid #f1f1ef">
        <a href="${esc(l.url)}" style="color:#37352f;text-decoration:none;font-weight:600">${esc(l.summary)}</a>
        ${l.body ? `<div style="color:#787774;font-size:13px;margin-top:2px;white-space:pre-wrap">${esc(l.body.slice(0, 200))}</div>` : ''}
      </td></tr>`,
    )
    .join('')}</table>${more ? `<p style="color:#787774;font-size:13px">…and ${more} more.</p>` : ''}`;
  return {
    subject,
    text: text([
      `Hi ${o.name}, here's what you missed in ${o.workspace}:`,
      lines.map((l) => `• ${l.summary}${l.body ? `\n  "${l.body.slice(0, 200)}"` : ''}\n  ${l.url}`).join('\n'),
      more ? `…and ${more} more.` : null,
      `Open your inbox: ${o.inboxUrl}`,
      `Email settings: ${o.settingsUrl}`,
      `Turn off digest emails: ${o.unsubscribeUrl}`,
    ]),
    html: layout({
      workspace: o.workspace,
      heading: subject,
      paragraphs: [`Hi ${esc(o.name)}, here's what you missed:`],
      extraHtml: listHtml,
      cta: { label: 'Open inbox', url: o.inboxUrl },
      unsubscribeUrl: o.unsubscribeUrl,
      footer: `Daily digest from ${esc(o.workspace)}. <a href="${esc(o.settingsUrl)}" style="color:#9b9a97">Email settings</a>.`,
    }),
  };
}

// ---------- external (account-less) sharing ----------

export function externalShareEmail(o: { workspace: string; sharer: string; pageTitle: string; url: string; message?: string | null; expires?: Date | null; verify: boolean }): Rendered {
  const title = pageName(o.pageTitle);
  const exp = o.expires ? o.expires.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : null;
  const notes = [
    exp ? `Access expires on ${exp}.` : null,
    o.verify ? `For security, we'll email you a one-time code when you open it.` : null,
    `This link is personal to you — please don't forward it.`,
  ].filter(Boolean) as string[];
  return {
    subject: `${o.sharer} shared “${title}” with you`,
    text: text([`${o.sharer} shared “${title}” with you (view only, no account needed).`, o.message ? `“${o.message}”` : null, `Open it: ${o.url}`, ...notes]),
    html: layout({
      workspace: o.workspace,
      heading: `${o.sharer} shared a page with you`,
      paragraphs: [`<b>${esc(o.sharer)}</b> shared <b>${esc(title)}</b> with you. You can view it without an account.`, ...notes.map(esc)],
      quote: o.message ?? undefined,
      cta: { label: 'Open page', url: o.url },
      footer: `You received this because ${esc(o.sharer)} shared a page with this email address. If this wasn't meant for you, ignore it.`,
    }),
  };
}

export function externalCodeEmail(o: { workspace: string; pageTitle: string; code: string }): Rendered {
  const title = pageName(o.pageTitle);
  return {
    subject: `${o.code} is your code to view “${title}”`,
    text: text([`Your verification code is: ${o.code}`, `It expires in 10 minutes. If you didn't try to open “${title}”, ignore this email.`]),
    html: layout({
      workspace: o.workspace,
      heading: 'Your verification code',
      paragraphs: [`Use this code to open <b>${esc(title)}</b>:`, `<span style="font-size:28px;font-weight:700;letter-spacing:6px;font-family:monospace">${esc(o.code)}</span>`, `It expires in 10 minutes.`],
      footer: `If you didn't try to open this page, you can ignore this email.`,
    }),
  };
}
