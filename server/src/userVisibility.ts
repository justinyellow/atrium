import type { AuthUser } from './auth.js';
import { q } from './db.js';

/**
 * Which people a user may see, and with which fields.
 * - Admins/owners: everyone, all fields.
 * - Members: every workspace member incl. email.
 * - Guests: only people they collaborate with (on pages shared with them), name + avatar only, no email.
 */
export async function visibleUsers(user: AuthUser, opts: { search?: string; limit?: number; activeOnly?: boolean } = {}) {
  const search = opts.search ? `%${opts.search}%` : null;
  const limit = opts.limit ?? 10000;
  if (user.role !== 'guest') {
    return q(
      `select u.id, u.name, u.email, u.avatar_url, u.active, m.role, m.created_at as joined_at
       from users u join workspace_members m on m.user_id = u.id
       where m.workspace_id = $1 and u.deleted_at is null
         and ($2::text is null or u.name ilike $2 or u.email ilike $2)
         and (not $3 or u.active)
       order by u.name limit $4`,
      [user.workspaceId, search, !!opts.activeOnly, limit],
    );
  }
  return q(
    `with recursive granted as (
       select page_id as id from page_permissions where principal_type = 'user' and principal_id = $1
       union
       select page_id from page_permissions where principal_type = 'group' and principal_id = any($2::uuid[])
     ), tree as (
       select id from granted
       union
       select p.id from pages p join tree t on p.parent_id = t.id
     ), people as (
       select principal_id as id from page_permissions where principal_type = 'user' and page_id in (select id from tree)
       union select created_by from pages where id in (select id from tree)
       union select updated_by from pages where id in (select id from tree)
       union select owner_id from pages where id in (select id from tree)
       union select c.author_id from comments c join comment_threads t on t.id = c.thread_id where t.page_id in (select id from tree)
     )
     select u.id, u.name, null::text as email, u.avatar_url, u.active, null::text as role, null::timestamptz as joined_at
     from users u join workspace_members m on m.user_id = u.id
     where m.workspace_id = $3 and u.deleted_at is null and u.active
       and (u.id = $1 or u.id in (select id from people where id is not null))
       and ($4::text is null or u.name ilike $4)
     order by u.name limit $5`,
    [user.id, user.groupIds, user.workspaceId, search, limit],
  );
}
