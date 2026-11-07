import { useQuery } from '@tanstack/react-query';
import { get } from '../../lib/api';
import type { Role } from '../../lib/types';

export interface WorkspaceSettings {
  allow_guests: boolean;
  invite_permission: 'admins' | 'members';
  allow_public_pages: boolean;
  allow_exports: boolean;
  allow_external_shares?: boolean;
  require_public_link_password?: boolean;
  default_teamspace_id: string | null;
}

/** Org-wide security settings (readable by every member; only admins can change them). */
export function useWorkspaceSettings(enabled = true) {
  return useQuery({ queryKey: ['ws-settings'], queryFn: () => get<WorkspaceSettings>('/workspace/settings'), enabled, staleTime: 30_000 });
}

export const isAdminRole = (r?: Role | null) => r === 'owner' || r === 'admin';

export function canInviteGuests(s: WorkspaceSettings | undefined, role?: Role | null) {
  if (!s || !s.allow_guests || role === 'guest') return false;
  return s.invite_permission === 'members' || isAdminRole(role);
}

export const EMAIL_RE = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;
