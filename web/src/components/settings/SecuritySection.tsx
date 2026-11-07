import { useQuery } from '@tanstack/react-query';
import { get, patch, queryClient } from '../../lib/api';
import { Toggle, toast } from '../ui';
import { useWorkspaceSettings, type WorkspaceSettings } from './useWorkspaceSettings';
import './admin.css';

function Row({ label, desc, children }: { label: string; desc: string; children: React.ReactNode }) {
  return (
    <div className="set-row">
      <div className="l"><div>{label}</div><div className="d">{desc}</div></div>
      {children}
    </div>
  );
}

/** Settings → General → Security (admins only). Enforced server-side. */
export function SecuritySection() {
  const s = useWorkspaceSettings();
  const ts = useQuery({ queryKey: ['teamspaces-admin'], queryFn: () => get<{ id: string; name: string; icon: string | null }[]>('/teamspaces') });
  const save = async (p: Partial<WorkspaceSettings>) => {
    try {
      const next = await patch<WorkspaceSettings>('/admin/settings', p);
      queryClient.setQueryData(['ws-settings'], next);
      toast('Security settings saved');
    } catch (e: any) {
      toast(e.message);
    }
  };
  const v = s.data;
  if (!v) return null;
  return (
    <>
      <h3>Security</h3>
      <Row label="Allow guests" desc="People outside the workspace can be invited to specific pages. Turning this off blocks new guest invites.">
        <Toggle checked={v.allow_guests} onChange={(x) => save({ allow_guests: x })} />
      </Row>
      <Row label="Who can invite guests" desc="From a page's Share menu, by typing an email address.">
        <select className="select" disabled={!v.allow_guests} value={v.invite_permission} onChange={(e) => save({ invite_permission: e.target.value as 'admins' | 'members' })}>
          <option value="members">Any member</option>
          <option value="admins">Admins only</option>
        </select>
      </Row>
      <Row label="Allow publishing to the web" desc="When off, nobody can create public links and existing public pages stop being served.">
        <Toggle checked={v.allow_public_pages} onChange={(x) => save({ allow_public_pages: x })} />
      </Row>
      <Row label="Require a password on public links" desc="Public links only work once a password is set. Existing links without a password stop working.">
        <Toggle checked={!!v.require_public_link_password} onChange={(x) => save({ require_public_link_password: x })} />
      </Row>
      <Row label="Allow sharing with people outside the workspace" desc="Members with full access can send view-only links to specific email addresses — no account needed. When off, new shares are blocked and existing links stop working.">
        <Toggle checked={v.allow_external_shares !== false} onChange={(x) => save({ allow_external_shares: x })} />
      </Row>
      <Row label="Allow exports" desc="Lets members and guests export pages as Markdown. Admins can always export.">
        <Toggle checked={v.allow_exports} onChange={(x) => save({ allow_exports: x })} />
      </Row>
      <Row label="Default teamspace for new members" desc="New members (not guests) are added to this teamspace when they join.">
        <select className="select" value={v.default_teamspace_id ?? ''} onChange={(e) => save({ default_teamspace_id: e.target.value || null })}>
          <option value="">None</option>
          {(ts.data ?? []).map((t) => <option key={t.id} value={t.id}>{t.icon} {t.name}</option>)}
        </select>
      </Row>
    </>
  );
}
