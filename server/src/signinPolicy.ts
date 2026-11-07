import { config } from './config.js';
import { one } from './db.js';

export type SigninMethod = 'auto' | 'sso' | 'password';

export const emailDomain = (email: string) => email.toLowerCase().trim().split('@')[1] ?? '';

/** True when the email's domain is one of the SSO domains (staff domains). */
export function isSsoDomain(email: string) {
  return config.sso.enabled && config.sso.allowedDomains.includes(emailDomain(email));
}

/**
 * Single source of truth for "may this person use a password?" — used by login, invite signup,
 * password reset and admin actions. Owners always keep a password (break-glass if the IdP is down).
 */
export function passwordAllowed(p: { email: string; role?: string | null; method?: SigninMethod | null }): { ok: boolean; reason?: string } {
  if (!config.sso.enabled) return { ok: true };
  if (p.role === 'owner') return { ok: true };
  const method = p.method ?? 'auto';
  if (method === 'password') return { ok: true };
  const label = config.sso.buttonLabel || 'single sign-on';
  if (method === 'sso') return { ok: false, reason: `Your account uses single sign-on. ${label}.` };
  switch (config.sso.passwordPolicy) {
    case 'allow':
      return { ok: true };
    case 'sso-only':
      return { ok: false, reason: `Password sign-in is disabled. ${label}.` };
    default:
      return isSsoDomain(p.email)
        ? { ok: false, reason: `@${emailDomain(p.email)} accounts sign in with single sign-on. ${label}.` }
        : { ok: true };
  }
}

export async function passwordAllowedForUser(userId: string) {
  const u = await one(
    `select u.email, u.signin_method, m.role from users u left join workspace_members m on m.user_id = u.id where u.id = $1`,
    [userId],
  );
  if (!u) return { ok: false, reason: 'Unknown user' };
  return passwordAllowed({ email: u.email, role: u.role, method: u.signin_method });
}
