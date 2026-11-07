/**
 * Cognito → Atrium deprovisioning and group re-sync.
 * Runs on the jobs-lock leader only. Deactivates Atrium users whose linked Cognito user is disabled
 * or deleted, reactivates users this job deactivated once Cognito re-enables them, and re-applies
 * Cognito group membership (role / IdP groups / teamspaces).
 *
 * Safety: never touches owners or users without a linked identity; dry-run mode; aborts a run that
 * would deactivate an unusually large share of users (misconfigured pool, wrong region, etc.).
 */
import {
  CognitoIdentityProviderClient, ListGroupsCommand, ListUsersCommand, ListUsersInGroupCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { config } from '../config.js';
import { one, q } from '../db.js';
import { workspaceId } from '../auth.js';
import { audit } from '../audit.js';
import { applyGroups } from '../sso.js';

export interface CognitoUser { username: string; sub: string; enabled: boolean; status?: string; email?: string }

export interface CognitoApi {
  listUsers(): Promise<CognitoUser[]>;
  listGroups(): Promise<string[]>;
  listUsersInGroup(group: string): Promise<string[]>; // usernames
}

export function awsCognitoApi(userPoolId: string, region?: string): CognitoApi {
  const client = new CognitoIdentityProviderClient({ region }); // default credential chain → ECS task role
  return {
    async listUsers() {
      const out: CognitoUser[] = [];
      let token: string | undefined;
      do {
        const r = await client.send(new ListUsersCommand({ UserPoolId: userPoolId, PaginationToken: token, Limit: 60 }));
        for (const u of r.Users ?? []) {
          const attr = (n: string) => u.Attributes?.find((a) => a.Name === n)?.Value;
          out.push({ username: u.Username!, sub: attr('sub') ?? u.Username!, enabled: u.Enabled !== false, status: u.UserStatus, email: attr('email') });
        }
        token = r.PaginationToken;
      } while (token);
      return out;
    },
    async listGroups() {
      const out: string[] = [];
      let token: string | undefined;
      do {
        const r = await client.send(new ListGroupsCommand({ UserPoolId: userPoolId, NextToken: token, Limit: 60 }));
        for (const g of r.Groups ?? []) if (g.GroupName) out.push(g.GroupName);
        token = r.NextToken;
      } while (token);
      return out;
    },
    async listUsersInGroup(group) {
      const out: string[] = [];
      let token: string | undefined;
      do {
        const r = await client.send(new ListUsersInGroupCommand({ UserPoolId: userPoolId, GroupName: group, NextToken: token, Limit: 60 }));
        for (const u of r.Users ?? []) if (u.Username) out.push(u.Username);
        token = r.NextToken;
      } while (token);
      return out;
    },
  };
}

export interface LinkedUser { userId: string; subject: string; username: string | null; role: string; active: boolean; deactivatedBy: string | null }

export interface SyncPlan {
  deactivate: { userId: string; reason: 'deleted' | 'disabled' | 'no_access_group' }[];
  reactivate: string[];
  groups: Map<string, string[]>; // userId → Cognito groups, for active, matched users
  unmatched: number;
  aborted?: string;
}

/** Pure planning step (unit-tested). */
export function planSync(linked: LinkedUser[], cognitoUsers: CognitoUser[], membership: Map<string, string[]>, maxDeactivatePct: number, requiredGroups: string[] = []): SyncPlan {
  const bySub = new Map(cognitoUsers.map((u) => [u.sub, u]));
  const byUsername = new Map(cognitoUsers.map((u) => [u.username, u]));
  const plan: SyncPlan = { deactivate: [], reactivate: [], groups: new Map(), unmatched: 0 };
  for (const l of linked) {
    if (l.role === 'owner') continue;
    const cu = bySub.get(l.subject) ?? (l.username ? byUsername.get(l.username) : undefined);
    if (!cu) {
      plan.unmatched++;
      if (l.active) plan.deactivate.push({ userId: l.userId, reason: 'deleted' });
      continue;
    }
    if (!cu.enabled) {
      if (l.active) plan.deactivate.push({ userId: l.userId, reason: 'disabled' });
      continue;
    }
    const userGroups = membership.get(cu.username) ?? [];
    if (requiredGroups.length && !userGroups.some((g) => requiredGroups.includes(g))) {
      if (l.active) plan.deactivate.push({ userId: l.userId, reason: 'no_access_group' as any });
      continue;
    }
    if (!l.active && l.deactivatedBy === 'sso') plan.reactivate.push(l.userId);
    if (l.active || l.deactivatedBy === 'sso') plan.groups.set(l.userId, membership.get(cu.username) ?? []);
  }
  const limit = Math.max(3, Math.ceil((linked.length * maxDeactivatePct) / 100));
  if (plan.deactivate.length > limit) {
    plan.aborted = `Would deactivate ${plan.deactivate.length} of ${linked.length} linked users (limit ${limit}). Check COGNITO_USER_POOL_ID / region.`;
  }
  return plan;
}

/** Which Cognito groups matter to Atrium (avoid listing members of unrelated groups). */
function relevantGroups(all: string[]) {
  const s = config.sso;
  return all.filter((g) => g in s.roleMap || g in s.teamspaceMap || s.requiredGroups.includes(g) || (s.groupSync && (!s.groupPrefix || g.startsWith(s.groupPrefix))));
}

export async function runCognitoSync(api: CognitoApi, opts: { dryRun?: boolean } = {}) {
  const dryRun = opts.dryRun ?? config.sso.cognito.dryRun;
  const run = await one<{ id: number }>('insert into sso_sync_runs(dry_run) values ($1) returning id', [dryRun]);
  const wsId = await workspaceId();
  let result: Record<string, unknown>;
  try {
    const linked = (
      await q(
        `select i.user_id, i.subject, i.username, m.role, u.active, u.deactivated_by
         from user_identities i join users u on u.id = i.user_id join workspace_members m on m.user_id = u.id
         where i.provider = $1`,
        [config.sso.issuer],
      )
    ).map((r: any): LinkedUser => ({ userId: r.user_id, subject: r.subject, username: r.username, role: r.role, active: r.active, deactivatedBy: r.deactivated_by }));
    const [users, groups] = await Promise.all([api.listUsers(), api.listGroups()]);
    const membership = new Map<string, string[]>();
    for (const g of relevantGroups(groups)) for (const u of await api.listUsersInGroup(g)) membership.set(u, [...(membership.get(u) ?? []), g]);
    const plan = planSync(linked, users, membership, config.sso.cognito.maxDeactivatePct, config.sso.requiredGroups);
    result = {
      linked: linked.length, cognitoUsers: users.length, deactivate: plan.deactivate.length, reactivate: plan.reactivate.length,
      unmatched: plan.unmatched, dryRun, aborted: plan.aborted ?? null, groupChanges: 0,
    };
    if (plan.aborted) {
      await audit({ workspaceId: wsId, action: 'sso.sync_aborted', meta: result });
    } else if (!dryRun) {
      for (const d of plan.deactivate) {
        await q(`update users set active = false, deactivated_by = 'sso' where id = $1`, [d.userId]);
        await q('delete from sessions where user_id = $1', [d.userId]);
        await audit({ workspaceId: wsId, action: 'sso.user_deactivated', targetType: 'user', targetId: d.userId, meta: { reason: d.reason, via: 'cognito_sync' } });
      }
      for (const id of plan.reactivate) {
        await q('update users set active = true, deactivated_by = null where id = $1', [id]);
        await audit({ workspaceId: wsId, action: 'sso.user_reactivated', targetType: 'user', targetId: id, meta: { via: 'cognito_sync' } });
      }
      let changed = 0;
      if (wsId) for (const [userId, g] of plan.groups) if (Object.keys(await applyGroups(wsId, userId, g, 'cognito_sync')).length) changed++;
      result.groupChanges = changed;
    } else {
      result.wouldDeactivate = plan.deactivate;
      result.wouldReactivate = plan.reactivate;
    }
  } catch (e: any) {
    result = { error: e.message, dryRun };
  }
  await q('update sso_sync_runs set finished_at = now(), result = $2 where id = $1', [run!.id, result]);
  return result;
}
