import { one, q } from './db.js';
import type { AuthUser } from './auth.js';
import { fail } from './auth.js';

/** Org-wide security settings (admins only). Stored in workspaces.settings jsonb. */
export interface WorkspaceSettings {
  /** Allow guest accounts (invites with role guest, share-to-email). */
  allow_guests: boolean;
  /** Who may invite guests from the Share menu. */
  invite_permission: 'admins' | 'members';
  /** Allow "Publish to web" (public links). */
  allow_public_pages: boolean;
  /** Allow sharing pages with specific email addresses that have no account (magic links). */
  allow_external_shares: boolean;
  /** Public links must be password protected. */
  require_public_link_password: boolean;
  /** Allow page exports (Markdown) and CSV exports for non-admins. */
  allow_exports: boolean;
  /** Teamspace new members are added to automatically (null = none beyond default teamspaces). */
  default_teamspace_id: string | null;
}

export const DEFAULT_SETTINGS: WorkspaceSettings = {
  allow_guests: true,
  invite_permission: 'members',
  allow_public_pages: true,
  allow_external_shares: true,
  require_public_link_password: false,
  allow_exports: true,
  default_teamspace_id: null,
};

let cache: { at: number; ws: string; s: WorkspaceSettings } | null = null;

export async function getSettings(workspaceId?: string): Promise<WorkspaceSettings> {
  if (cache && Date.now() - cache.at < 5000 && (!workspaceId || cache.ws === workspaceId)) return cache.s;
  const r = await one<{ id: string; settings: Partial<WorkspaceSettings> }>(
    workspaceId ? 'select id, settings from workspaces where id = $1' : 'select id, settings from workspaces order by created_at limit 1',
    workspaceId ? [workspaceId] : [],
  );
  const s = { ...DEFAULT_SETTINGS, ...(r?.settings ?? {}) };
  if (r) cache = { at: Date.now(), ws: r.id, s };
  return s;
}

export async function updateSettings(workspaceId: string, patch: Partial<WorkspaceSettings>) {
  const clean: Partial<WorkspaceSettings> = {};
  if (typeof patch.allow_guests === 'boolean') clean.allow_guests = patch.allow_guests;
  if (patch.invite_permission === 'admins' || patch.invite_permission === 'members') clean.invite_permission = patch.invite_permission;
  if (typeof patch.allow_public_pages === 'boolean') clean.allow_public_pages = patch.allow_public_pages;
  if (typeof patch.allow_exports === 'boolean') clean.allow_exports = patch.allow_exports;
  if (typeof patch.allow_external_shares === 'boolean') clean.allow_external_shares = patch.allow_external_shares;
  if (typeof patch.require_public_link_password === 'boolean') clean.require_public_link_password = patch.require_public_link_password;
  if (patch.default_teamspace_id !== undefined) {
    if (patch.default_teamspace_id) {
      const t = await one('select 1 from teamspaces where id = $1 and workspace_id = $2', [patch.default_teamspace_id, workspaceId]);
      if (!t) fail(400, 'Unknown teamspace');
    }
    clean.default_teamspace_id = patch.default_teamspace_id || null;
  }
  await q('update workspaces set settings = settings || $2 where id = $1', [workspaceId, JSON.stringify(clean)]);
  cache = null;
  return { changed: clean, settings: await getSettings(workspaceId) };
}

const isAdminRole = (r: string) => r === 'owner' || r === 'admin';

export async function assertExportsAllowed(user: AuthUser) {
  if (isAdminRole(user.role)) return;
  if (!(await getSettings(user.workspaceId)).allow_exports) fail(403, 'Exports are disabled by your workspace admin');
}

export async function assertPublishAllowed(user: AuthUser) {
  if (!(await getSettings(user.workspaceId)).allow_public_pages) fail(403, 'Publishing to the web is disabled by your workspace admin');
}

export async function assertCanInviteGuests(user: AuthUser) {
  const s = await getSettings(user.workspaceId);
  if (!s.allow_guests) fail(403, 'Guests are disabled by your workspace admin');
  if (user.role === 'guest') fail(403, 'Guests cannot invite people');
  if (s.invite_permission === 'admins' && !isAdminRole(user.role)) fail(403, 'Only admins can invite guests');
}

/** Called after a user joins: add them to the configured default teamspace. */
export async function applyNewMemberDefaults(userId: string, role: string) {
  if (role === 'guest') return;
  const s = await getSettings();
  if (s.default_teamspace_id) {
    await q(
      `insert into teamspace_members(teamspace_id, user_id, role) values ($1,$2,'member') on conflict do nothing`,
      [s.default_teamspace_id, userId],
    ).catch(() => {});
  }
}
