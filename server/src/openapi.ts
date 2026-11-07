// Hand-maintained OpenAPI description of the Atrium API (every route the server exposes).
// Paths are relative to /api/v1 unless an operation sets its own server (OAuth, MCP, SCIM, WebSockets).

type Op = {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  path: string;
  tag: string;
  summary: string;
  body?: Record<string, any>;
  query?: Record<string, string>;
  admin?: boolean;
  public?: boolean;
  server?: string;
  description?: string;
};

const obj = (props: Record<string, any>, required: string[] = []) => ({ type: 'object', properties: props, required });
const str = { type: 'string' };
const bool = { type: 'boolean' };
const num = { type: 'number' };
const uuid = { type: 'string', format: 'uuid' };
const arr = (items: any = str) => ({ type: 'array', items });
const role = { enum: ['owner', 'admin', 'member', 'guest'] };
const level = { enum: ['view', 'comment', 'edit', 'full'] };

const filter = {
  type: 'object',
  description: 'Filter group. `filters` items are either {prop, op, value} or nested groups.',
  properties: { op: { enum: ['and', 'or'] }, filters: arr({ type: 'object' }) },
};

const ROOT = '/';

const ops: Op[] = [
  // ---------- system ----------
  { method: 'get', path: '/health', tag: 'System', summary: 'Liveness probe', public: true },
  { method: 'get', path: '/ready', tag: 'System', summary: 'Readiness probe (DB, Redis, storage; 503 while draining)', public: true },
  { method: 'get', path: '/openapi.json', tag: 'System', summary: 'This document', public: true },

  // ---------- auth & account ----------
  { method: 'get', path: '/auth/status', tag: 'Auth', summary: 'Setup state, workspace and current user (if any)', public: true },
  { method: 'post', path: '/auth/setup', tag: 'Auth', summary: 'First-run: create the owner account and workspace (requires SETUP_TOKEN when configured)', public: true, body: obj({ name: str, email: str, password: str, workspaceName: str, setupToken: str }, ['name', 'email', 'password']) },
  { method: 'post', path: '/auth/login', tag: 'Auth', summary: 'Password login (sets session cookie; rate-limited)', public: true, body: obj({ email: str, password: str }, ['email', 'password']) },
  { method: 'post', path: '/auth/logout', tag: 'Auth', summary: 'End the current session' },
  { method: 'get', path: '/auth/invite/{token}', tag: 'Auth', summary: 'Inspect an invite link', public: true },
  { method: 'post', path: '/auth/signup', tag: 'Auth', summary: 'Accept an invite and create an account (applies page grants from guest invites)', public: true, body: obj({ token: str, name: str, email: str, password: str }, ['token', 'name', 'email', 'password']) },
  { method: 'post', path: '/auth/forgot', tag: 'Auth', summary: 'Request a password reset email (always returns ok)', public: true, body: obj({ email: str }, ['email']) },
  { method: 'get', path: '/auth/reset/{token}', tag: 'Auth', summary: 'Check a password reset token', public: true },
  { method: 'post', path: '/auth/reset', tag: 'Auth', summary: 'Set a new password with a reset token', public: true, body: obj({ token: str, password: str }, ['token', 'password']) },
  { method: 'get', path: '/auth/sso/login', tag: 'SSO', summary: 'Start OIDC single sign-on (redirects to the identity provider, e.g. Cognito)', public: true, query: { next: 'Path to return to after login' } },
  { method: 'get', path: '/auth/sso/callback', tag: 'SSO', summary: 'OIDC redirect URI (code exchange, JIT provisioning, group sync)', public: true },
  { method: 'get', path: '/me', tag: 'Account', summary: 'Current user and workspace' },
  { method: 'patch', path: '/me', tag: 'Account', summary: 'Update name, avatar, theme or password', body: obj({ name: str, avatar_url: str, theme: { enum: ['system', 'light', 'dark'] }, password: str, currentPassword: str }) },
  { method: 'get', path: '/me/sessions', tag: 'Account', summary: 'Devices where you are logged in (`current` marks this one)' },
  { method: 'delete', path: '/me/sessions/{id}', tag: 'Account', summary: 'Log out one device' },
  { method: 'post', path: '/me/sessions/logout-others', tag: 'Account', summary: 'Log out every device except this one' },
  { method: 'get', path: '/me/notification-prefs', tag: 'Account', summary: 'Email notification preferences' },
  { method: 'put', path: '/me/notification-prefs', tag: 'Account', summary: 'Update email notification preferences (per event: off | immediate | digest)', body: { type: 'object', additionalProperties: str } },
  { method: 'get', path: '/tokens', tag: 'Account', summary: 'List your personal API tokens' },
  { method: 'post', path: '/tokens', tag: 'Account', summary: 'Create a personal API token (shown once)', body: obj({ name: str }) },
  { method: 'delete', path: '/tokens/{id}', tag: 'Account', summary: 'Revoke an API token' },
  { method: 'get', path: '/email/unsubscribe', tag: 'Account', summary: 'One-click unsubscribe landing (signed link from emails)', public: true, query: { u: 'User id', k: 'Preference key', s: 'Signature' } },
  { method: 'post', path: '/email/unsubscribe', tag: 'Account', summary: 'RFC 8058 one-click unsubscribe', public: true, query: { u: 'User id', k: 'Preference key', s: 'Signature' } },

  // ---------- people ----------
  { method: 'get', path: '/users', tag: 'People', summary: 'People you can see. Guests only see collaborators, without email addresses.' },
  { method: 'patch', path: '/users/{id}', tag: 'People', summary: 'Legacy: change role or active flag (prefer /admin/users)', admin: true, body: obj({ role, active: bool }) },
  { method: 'get', path: '/mentions', tag: 'People', summary: 'People and pages matching an @-mention query', query: { q: 'Search text' } },
  { method: 'get', path: '/groups', tag: 'People', summary: 'Groups and their members (empty for guests)' },
  { method: 'post', path: '/groups', tag: 'People', summary: 'Create a group', admin: true, body: obj({ name: str }) },
  { method: 'patch', path: '/groups/{id}', tag: 'People', summary: 'Rename a group or replace its members', admin: true, body: obj({ name: str, members: arr(uuid) }) },
  { method: 'delete', path: '/groups/{id}', tag: 'People', summary: 'Delete a group', admin: true },
  { method: 'get', path: '/invites', tag: 'People', summary: 'Pending invites', admin: true },
  { method: 'post', path: '/invites', tag: 'People', summary: 'Create an invite link (emailed when bound to an address)', admin: true, body: obj({ email: str, role: { enum: ['admin', 'member', 'guest'] }, days: num }) },
  { method: 'delete', path: '/invites/{token}', tag: 'People', summary: 'Revoke an invite', admin: true },
  { method: 'post', path: '/invites/{token}/send', tag: 'People', summary: 'Re-send an invite email', admin: true, body: obj({ email: str }) },

  // ---------- admin ----------
  { method: 'get', path: '/admin/users', tag: 'Admin', summary: 'Search and filter members', admin: true, query: { q: 'Name or email', role: 'owner|admin|member|guest', status: 'all|active|deactivated', limit: 'Max 500', offset: 'Paging offset' } },
  { method: 'post', path: '/admin/users', tag: 'Admin', summary: 'Create a user directly and email them a set-password link', admin: true, body: obj({ name: str, email: str, role, groups: arr(uuid), teamspaces: arr(uuid), sendEmail: bool }, ['name', 'email']) },
  { method: 'get', path: '/admin/users.csv', tag: 'Admin', summary: 'Export members as CSV', admin: true },
  { method: 'get', path: '/admin/users/{id}', tag: 'Admin', summary: 'Member details: groups, teamspaces, sessions, content counts', admin: true },
  { method: 'patch', path: '/admin/users/{id}', tag: 'Admin', summary: 'Change name, email (unique) or role', admin: true, body: obj({ name: str, email: str, role }) },
  { method: 'post', path: '/admin/users/{id}/reset-password', tag: 'Admin', summary: 'Email a password reset link, or return a one-time link when sendEmail=false', admin: true, body: obj({ sendEmail: bool }) },
  { method: 'post', path: '/admin/users/{id}/logout', tag: 'Admin', summary: 'Sign a user out everywhere (sessions; optionally API tokens and connected apps)', admin: true, body: obj({ apiTokens: bool, oauth: bool }) },
  { method: 'post', path: '/admin/users/{id}/deactivate', tag: 'Admin', summary: 'Deactivate (blocks login, revokes sessions and app grants)', admin: true },
  { method: 'post', path: '/admin/users/{id}/reactivate', tag: 'Admin', summary: 'Reactivate a deactivated user', admin: true },
  {
    method: 'delete', path: '/admin/users/{id}', tag: 'Admin', admin: true,
    summary: 'Offboard: transfer private pages, remove access and memberships, anonymise contact details',
    description: 'Options may be sent as JSON body or query string. Private pages move under a "From <name>" page owned by `transferTo` (or into `teamspaceId`). Authored content keeps attribution.',
    body: obj({ transferTo: uuid, teamspaceId: uuid, anonymiseName: bool }, ['transferTo']),
  },
  { method: 'post', path: '/admin/invites/bulk', tag: 'Admin', summary: 'Invite many people from a list of emails or CSV text (per-email results)', admin: true, body: obj({ emails: arr(), csv: str, role: { enum: ['admin', 'member', 'guest'] }, days: num, sendEmail: bool, message: str }) },
  { method: 'get', path: '/admin/audit', tag: 'Admin', summary: 'Audit log', admin: true, query: { action: 'Action or prefix (e.g. "user" or "page.published")', actor: 'Actor user id', target: 'Target id', targetType: 'page|user|teamspace|group|workspace|invite|token|…', from: 'ISO timestamp (inclusive)', to: 'ISO timestamp (exclusive)', limit: 'Max 500', offset: 'Paging offset' } },
  { method: 'get', path: '/admin/audit.csv', tag: 'Admin', summary: 'Export the audit log as CSV (same filters)', admin: true },
  { method: 'post', path: '/admin/import/notion', tag: 'Import', summary: 'Start a Notion import (or a dry-run preview) in the background', description: 'Reads pages, databases (schema, rows, views, templates), files, comments and people through the official Notion API with the given integration token (used for this job only, never stored). Re-running updates previously imported items instead of duplicating them.', admin: true, body: obj({ token: str, rootIds: { type: 'array', items: str, description: 'Notion page/database ids or URLs; empty = everything shared with the integration' }, targetTeamspaceId: uuid, peopleMode: { enum: ['text', 'guests'] }, dryRun: bool, force: bool }, ['token', 'targetTeamspaceId']) },
  { method: 'get', path: '/admin/import/jobs', tag: 'Import', summary: 'Recent import jobs', admin: true },
  { method: 'get', path: '/admin/import/jobs/{id}', tag: 'Import', summary: 'Import job progress and report (counts, warnings, imported roots)', admin: true },
  { method: 'post', path: '/admin/import/jobs/{id}/cancel', tag: 'Import', summary: 'Cancel a running import', admin: true },
  { method: 'get', path: '/workspace/settings', tag: 'Admin', summary: 'Workspace security settings (readable by members)' },
  { method: 'patch', path: '/admin/settings', tag: 'Admin', summary: 'Change workspace security settings', admin: true, body: obj({ allow_guests: bool, invite_permission: { enum: ['admins', 'members'] }, allow_public_pages: bool, allow_exports: bool, default_teamspace_id: uuid }) },
  { method: 'post', path: '/admin/trash/purge', tag: 'Admin', summary: 'Permanently delete trash older than TRASH_RETENTION_DAYS now', admin: true },
  { method: 'patch', path: '/workspace', tag: 'Admin', summary: 'Rename the workspace or change its icon', admin: true, body: obj({ name: str, icon: str }) },
  { method: 'get', path: '/admin/email/status', tag: 'Admin', summary: 'Email driver status and outbox counts', admin: true },
  { method: 'post', path: '/admin/email/test', tag: 'Admin', summary: 'Send a test email', admin: true, body: obj({ to: str }) },
  { method: 'post', path: '/admin/email/digest', tag: 'Admin', summary: 'Send a notification digest now', admin: true, body: obj({ userId: uuid }) },
  { method: 'get', path: '/sso/settings', tag: 'SSO', summary: 'SSO configuration status, group mappings and SCIM tokens', admin: true },
  { method: 'patch', path: '/sso/settings', tag: 'SSO', summary: 'Update SSO allowed email domains', admin: true, body: obj({ allowed_domains: arr() }) },
  { method: 'post', path: '/sso/scim-tokens', tag: 'SSO', summary: 'Create a SCIM bearer token (shown once)', admin: true, body: obj({ name: str }) },
  { method: 'delete', path: '/sso/scim-tokens/{id}', tag: 'SSO', summary: 'Revoke a SCIM token', admin: true },
  { method: 'post', path: '/sso/cognito-sync', tag: 'SSO', summary: 'Reconcile users and groups with Cognito now (deactivates removed users)', admin: true, body: obj({ dryRun: bool }) },

  // ---------- teamspaces ----------
  { method: 'get', path: '/teamspaces', tag: 'Teamspaces', summary: 'List teamspaces with members' },
  { method: 'post', path: '/teamspaces', tag: 'Teamspaces', summary: 'Create a teamspace', body: obj({ name: str, icon: str, description: str, is_default: bool }) },
  { method: 'patch', path: '/teamspaces/{id}', tag: 'Teamspaces', summary: 'Update a teamspace (teamspace owners/admins)', body: obj({ name: str, icon: str, description: str, is_default: bool, default_level: level }) },
  { method: 'delete', path: '/teamspaces/{id}', tag: 'Teamspaces', summary: 'Delete a teamspace' },
  { method: 'put', path: '/teamspaces/{id}/members/{uid}', tag: 'Teamspaces', summary: 'Add a member or change their teamspace role', body: obj({ role: { enum: ['owner', 'member'] } }) },
  { method: 'delete', path: '/teamspaces/{id}/members/{uid}', tag: 'Teamspaces', summary: 'Remove a member (or leave)' },

  // ---------- pages ----------
  { method: 'get', path: '/tree', tag: 'Pages', summary: 'Sidebar tree: pages visible to you, teamspaces, favorites, shared' },
  { method: 'get', path: '/search', tag: 'Pages', summary: 'Search pages by title and content', query: { q: 'Search text', limit: 'Max 50' } },
  { method: 'get', path: '/recent', tag: 'Pages', summary: 'Recently visited pages' },
  { method: 'post', path: '/pages', tag: 'Pages', summary: 'Create a page (or database with kind=database)', body: obj({ parentId: uuid, teamspaceId: uuid, title: str, icon: str, kind: { enum: ['page', 'database'] }, markdown: str, blocks: arr({ type: 'object' }) }) },
  { method: 'get', path: '/pages/{id}', tag: 'Pages', summary: 'Page metadata, your access level and breadcrumbs' },
  { method: 'patch', path: '/pages/{id}', tag: 'Pages', summary: 'Update title, icon, cover, flags or row properties', body: obj({ title: str, icon: str, cover: str, full_width: bool, small_text: bool, locked: bool, props: { type: 'object' } }) },
  { method: 'delete', path: '/pages/{id}', tag: 'Pages', summary: 'Move a page (and sub-pages) to Trash' },
  { method: 'post', path: '/pages/{id}/restore', tag: 'Pages', summary: 'Restore from Trash' },
  { method: 'delete', path: '/pages/{id}/permanent', tag: 'Pages', summary: 'Permanently delete a page that is in Trash' },
  { method: 'get', path: '/trash', tag: 'Pages', summary: 'Pages in Trash you can manage', query: { q: 'Filter by title' } },
  { method: 'post', path: '/pages/{id}/move', tag: 'Pages', summary: 'Move a page', body: obj({ parentId: uuid, teamspaceId: uuid, position: num }) },
  { method: 'post', path: '/pages/{id}/duplicate', tag: 'Pages', summary: 'Duplicate a page and its sub-pages' },
  { method: 'post', path: '/pages/{id}/visit', tag: 'Pages', summary: 'Record a visit (powers Recent)' },
  { method: 'get', path: '/pages/{id}/content', tag: 'Pages', summary: 'Page body: blocks (default), rich (lossless Notion-flavored Markdown) or markdown (lossy CommonMark)', query: { format: 'blocks | rich | markdown', base: 'base URL used for page links in rich output' } },
  { method: 'put', path: '/pages/{id}/content', tag: 'Pages', summary: 'Write the page body block-granularly (untouched blocks keep ids; applied live to open editors). Returns warnings for unrepresentable references.', body: obj({ rich: str, markdown: str, blocks: arr({ type: 'object' }), mode: { enum: ['replace', 'append', 'prepend', 'insert_after', 'replace_range', 'update'] }, selection: str, updates: arr(obj({ old_str: str, new_str: str, replace_all_matches: { type: 'boolean' } })), base: str }) },
  { method: 'get', path: '/pages/{id}/export', tag: 'Pages', summary: 'Download the page as Markdown (respects allow_exports)' },
  { method: 'post', path: '/import/markdown', tag: 'Pages', summary: 'Create a page from Markdown', body: obj({ markdown: str, title: str, parentId: uuid, teamspaceId: uuid }, ['markdown']) },
  { method: 'get', path: '/pages/{id}/backlinks', tag: 'Pages', summary: 'Pages linking here' },
  { method: 'get', path: '/pages/{id}/versions', tag: 'Pages', summary: 'Version history' },
  { method: 'get', path: '/pages/{id}/versions/{vid}', tag: 'Pages', summary: 'A past version (blocks)' },
  { method: 'post', path: '/pages/{id}/versions/{vid}/restore', tag: 'Pages', summary: 'Restore a version' },
  { method: 'put', path: '/favorites/{id}', tag: 'Pages', summary: 'Add a page to Favorites' },
  { method: 'delete', path: '/favorites/{id}', tag: 'Pages', summary: 'Remove from Favorites' },
  { method: 'get', path: '/public/pages/{id}', tag: 'Sharing', summary: 'Public / externally shared page (by id or slug). 401 {needsPassword} for password-protected links', public: true },
  { method: 'post', path: '/public/pages/{id}/unlock', tag: 'Sharing', summary: 'Unlock a password-protected public link (sets a cookie for the shared subtree; rate-limited)', public: true, body: obj({ password: str }, ['password']) },
  { method: 'post', path: '/public/external/redeem', tag: 'Sharing', summary: 'Redeem a personal email link; returns {pageId} or {needsCode, emailHint}', public: true, body: obj({ token: str }, ['token']) },
  { method: 'post', path: '/public/external/verify', tag: 'Sharing', summary: 'Confirm the 6-digit email code for a link that requires verification', public: true, body: obj({ token: str, code: str }, ['token', 'code']) },
  { method: 'patch', path: '/pages/{id}/public', tag: 'Sharing', summary: "Set / change / remove the public link's password, and its expiry", body: obj({ password: str, expiresAt: str }) },
  { method: 'get', path: '/pages/{id}/external-shares', tag: 'Sharing', summary: 'People outside the workspace with a personal link (incl. inherited from parent pages)' },
  { method: 'post', path: '/pages/{id}/external-shares', tag: 'Sharing', summary: 'Share this page and its sub-pages with email addresses — no accounts; emails a personal view-only link', body: obj({ emails: { type: 'array', items: str }, message: str, expiresAt: str, requireVerification: { type: 'boolean' } }, ['emails']) },
  { method: 'delete', path: '/external-shares/{sid}', tag: 'Sharing', summary: 'Revoke an external share (ends their sessions)' },
  { method: 'post', path: '/external-shares/{sid}/resend', tag: 'Sharing', summary: 'Email a fresh link (the previous link stops working)' },
  { method: 'get', path: '/blocks/synced/{id}', tag: 'Pages', summary: 'Synced block source and the pages that reference it' },
  { method: 'post', path: '/blocks/synced', tag: 'Pages', summary: 'Create a synced block source', body: obj({ pageId: uuid }) },
  { method: 'get', path: '/unfurl', tag: 'Pages', summary: 'Link preview metadata for a URL (SSRF-guarded)', query: { url: 'http(s) URL' } },

  // ---------- sharing ----------
  { method: 'get', path: '/pages/{id}/permissions', tag: 'Sharing', summary: 'Who has access (direct and inherited)' },
  { method: 'put', path: '/pages/{id}/permissions', tag: 'Sharing', summary: 'Grant access (user, group, whole workspace, or public web link)', body: obj({ principal_type: { enum: ['user', 'group', 'workspace', 'public'] }, principal_id: uuid, level }, ['principal_type', 'level']) },
  { method: 'delete', path: '/pages/{id}/permissions/{pid}', tag: 'Sharing', summary: 'Revoke access' },
  { method: 'post', path: '/pages/{id}/invite-guest', tag: 'Sharing', summary: 'Share with an email address: grants directly if a member, otherwise sends a guest invite', body: obj({ email: str, level, message: str }, ['email']) },

  // ---------- comments & inbox ----------
  { method: 'get', path: '/pages/{id}/comments', tag: 'Comments', summary: 'Comment threads on a page' },
  { method: 'post', path: '/pages/{id}/comments', tag: 'Comments', summary: 'Add a comment (new thread, or reply with threadId)', body: obj({ body: str, threadId: uuid, blockId: str, quote: str }, ['body']) },
  { method: 'patch', path: '/comments/{cid}', tag: 'Comments', summary: 'Edit your comment or toggle a reaction', body: obj({ body: str, reaction: str }) },
  { method: 'delete', path: '/comments/{cid}', tag: 'Comments', summary: 'Delete a comment' },
  { method: 'patch', path: '/threads/{tid}', tag: 'Comments', summary: 'Resolve or reopen a thread', body: obj({ resolved: bool }) },
  { method: 'get', path: '/notifications', tag: 'Inbox', summary: 'Inbox notifications', query: { archived: 'true to list archived' } },
  { method: 'get', path: '/notifications/unread', tag: 'Inbox', summary: 'Unread count' },
  { method: 'post', path: '/notifications/read', tag: 'Inbox', summary: 'Mark read or archive', body: obj({ ids: arr(uuid), all: bool, archive: bool }) },

  // ---------- databases ----------
  { method: 'get', path: '/databases', tag: 'Databases', summary: 'Databases you can see' },
  { method: 'get', path: '/databases/{id}', tag: 'Databases', summary: 'Schema, views and templates (?blockId= for a linked view block)', query: { blockId: 'Linked-view block id' } },
  { method: 'post', path: '/databases/{id}/query', tag: 'Databases', summary: 'Query rows (filters, sorts, search; or a saved view)', body: obj({ viewId: uuid, filter, sorts: arr(obj({ prop: str, dir: { enum: ['asc', 'desc'] } })), search: str, templates: bool }) },
  { method: 'post', path: '/databases/{id}/rows', tag: 'Databases', summary: 'Create a row', body: obj({ title: str, props: { type: 'object', description: 'Values keyed by property id' }, templateId: uuid, markdown: str, position: num }) },
  { method: 'post', path: '/databases/{id}/rows/reorder', tag: 'Databases', summary: 'Set manual row order', body: obj({ order: arr(uuid) }) },
  { method: 'post', path: '/databases/{id}/properties', tag: 'Databases', summary: 'Add a property', body: obj({ name: str, type: str, options: arr({ type: 'object' }), relation: obj({ databaseId: uuid }), twoWay: bool, formula: obj({ expression: str }), rollup: { type: 'object' } }) },
  { method: 'patch', path: '/databases/{id}/properties/{pid}', tag: 'Databases', summary: 'Rename, retype or reconfigure a property (values are converted)' },
  { method: 'delete', path: '/databases/{id}/properties/{pid}', tag: 'Databases', summary: 'Delete a property' },
  { method: 'put', path: '/databases/{id}/properties/order', tag: 'Databases', summary: 'Reorder properties', body: obj({ order: arr() }) },
  { method: 'post', path: '/databases/{id}/views', tag: 'Databases', summary: 'Add a view', body: obj({ name: str, type: { enum: ['table', 'board', 'list', 'gallery', 'calendar', 'timeline'] }, config: { type: 'object' }, blockId: str }) },
  { method: 'patch', path: '/views/{vid}', tag: 'Databases', summary: 'Update a view (config merges at the top level)', body: obj({ name: str, type: str, config: { type: 'object' }, position: num }) },
  { method: 'delete', path: '/views/{vid}', tag: 'Databases', summary: 'Delete a view' },
  { method: 'post', path: '/views/{vid}/duplicate', tag: 'Databases', summary: 'Duplicate a view' },

  // ---------- files ----------
  { method: 'post', path: '/files', tag: 'Files', summary: 'Upload a file (multipart/form-data, field "file")' },
  { method: 'get', path: '/files/{id}', tag: 'Files', summary: 'Download a file' },

  // ---------- realtime (WebSocket) ----------
  { method: 'get', path: '/events', tag: 'Realtime', summary: 'WebSocket: invalidation events (tree, page, db, comments, notifications)' },
  { method: 'get', path: '/collab', tag: 'Realtime', summary: 'WebSocket: Yjs/Hocuspocus live document sync (document name = page id)', server: ROOT },

  // ---------- MCP & OAuth (served at the site root) ----------
  {
    method: 'post', path: '/mcp', tag: 'MCP', server: ROOT,
    summary: 'Remote MCP server (Streamable HTTP, stateless JSON-RPC)',
    description: 'Authenticate with `Authorization: Bearer <API token atr_… or OAuth access token ato_…>`. Tools run as the token owner. GET and DELETE return 405.',
  },
  { method: 'get', path: '/.well-known/oauth-protected-resource', tag: 'OAuth', summary: 'Protected resource metadata (RFC 9728)', public: true, server: ROOT },
  { method: 'get', path: '/.well-known/oauth-authorization-server', tag: 'OAuth', summary: 'Authorization server metadata (RFC 8414)', public: true, server: ROOT },
  { method: 'post', path: '/oauth/register', tag: 'OAuth', summary: 'Dynamic client registration (RFC 7591)', public: true, server: ROOT, body: obj({ client_name: str, redirect_uris: arr() }, ['redirect_uris']) },
  { method: 'get', path: '/oauth/authorize', tag: 'OAuth', summary: 'Authorization endpoint (PKCE S256 required; redirects to the consent screen)', public: true, server: ROOT },
  { method: 'post', path: '/oauth/token', tag: 'OAuth', summary: 'Token endpoint (authorization_code with PKCE, refresh_token rotation)', public: true, server: ROOT },
  { method: 'post', path: '/oauth/revoke', tag: 'OAuth', summary: 'Token revocation (RFC 7009)', public: true, server: ROOT },
  { method: 'get', path: '/oauth/clients/{id}', tag: 'OAuth', summary: 'Client details for the consent screen' },
  { method: 'post', path: '/oauth/approve', tag: 'OAuth', summary: 'Approve or deny an authorization request (consent screen)', body: obj({ client_id: str, redirect_uri: str, code_challenge: str, code_challenge_method: str, state: str, resource: str, approve: bool }) },
  { method: 'get', path: '/oauth/connections', tag: 'OAuth', summary: 'Apps you have connected' },
  { method: 'delete', path: '/oauth/connections/{id}', tag: 'OAuth', summary: 'Disconnect an app (revokes its tokens)' },

  // ---------- SCIM 2.0 (served at /scim/v2) ----------
  { method: 'get', path: '/ServiceProviderConfig', tag: 'SCIM', summary: 'SCIM service provider configuration', server: '/scim/v2', description: 'SCIM 2.0 (RFC 7643/7644) for identity providers. Authenticate with a SCIM bearer token from Settings → SSO & provisioning.' },
  { method: 'get', path: '/Schemas', tag: 'SCIM', summary: 'SCIM schemas', server: '/scim/v2' },
  { method: 'get', path: '/ResourceTypes', tag: 'SCIM', summary: 'SCIM resource types', server: '/scim/v2' },
  { method: 'get', path: '/Users', tag: 'SCIM', summary: 'List/filter users (e.g. filter=userName eq "a@b.com")', server: '/scim/v2' },
  { method: 'post', path: '/Users', tag: 'SCIM', summary: 'Provision a user', server: '/scim/v2' },
  { method: 'get', path: '/Users/{id}', tag: 'SCIM', summary: 'Get a user', server: '/scim/v2' },
  { method: 'put', path: '/Users/{id}', tag: 'SCIM', summary: 'Replace a user', server: '/scim/v2' },
  { method: 'patch', path: '/Users/{id}', tag: 'SCIM', summary: 'Patch a user (e.g. active=false deactivates)', server: '/scim/v2' },
  { method: 'delete', path: '/Users/{id}', tag: 'SCIM', summary: 'Deprovision a user', server: '/scim/v2' },
  { method: 'get', path: '/Groups', tag: 'SCIM', summary: 'List groups', server: '/scim/v2' },
  { method: 'post', path: '/Groups', tag: 'SCIM', summary: 'Create a group', server: '/scim/v2' },
  { method: 'get', path: '/Groups/{id}', tag: 'SCIM', summary: 'Get a group', server: '/scim/v2' },
  { method: 'put', path: '/Groups/{id}', tag: 'SCIM', summary: 'Replace a group', server: '/scim/v2' },
  { method: 'patch', path: '/Groups/{id}', tag: 'SCIM', summary: 'Patch group members', server: '/scim/v2' },
  { method: 'delete', path: '/Groups/{id}', tag: 'SCIM', summary: 'Delete a group', server: '/scim/v2' },
  // ----- AI -----
  { method: 'get', path: '/ai/status', tag: 'AI', summary: 'Whether AI is available to you, enabled features, models and budget usage' },
  { method: 'post', path: '/ai/write', tag: 'AI', summary: 'Ask AI on a text selection (streamed)', description: `Events: delta {text}, done {usage}, error {message}. Response is text/event-stream ("event: <name>" lines followed by JSON "data:" lines). 402 when the AI budget is used up.`, body: obj({ action: { enum: ['improve', 'fix', 'shorter', 'longer', 'summarize', 'translate', 'continue', 'explain', 'tone', 'custom'] }, text: str, prompt: str, language: str, tone: str, pageId: uuid }, ['action', 'text']) },
  { method: 'post', path: '/ai/chat', tag: 'AI', summary: 'Chat with Atrium AI: workspace Q&A (ask) or an agent that acts as you (agent)', description: `Events: conversation {id,title}, delta {text}, tool_call {id,name,input,summary}, tool_result {id,ok,summary,pageId?}, confirm {id,name,input,summary}, citations {pages}, done {usage}, error {message}. Response is text/event-stream ("event: <name>" lines followed by JSON "data:" lines). Destructive agent actions pause with a confirm event.`, body: obj({ conversationId: uuid, message: str, mode: { enum: ['ask', 'agent'] }, pageId: uuid }, ['message']) },
  { method: 'post', path: '/ai/chat/{id}/confirm', tag: 'AI', summary: 'Approve or decline a paused agent action and continue the turn (streamed)', body: obj({ toolCallId: str, approve: bool }, ['toolCallId', 'approve']) },
  { method: 'get', path: '/ai/conversations', tag: 'AI', summary: 'Your AI conversations' },
  { method: 'get', path: '/ai/conversations/{id}', tag: 'AI', summary: 'One conversation with its messages and any pending approvals' },
  { method: 'delete', path: '/ai/conversations/{id}', tag: 'AI', summary: 'Delete a conversation' },
  { method: 'post', path: '/databases/{id}/ai-fill', tag: 'AI', summary: 'Fill an AI autofill property for all (or some) rows in the background', body: obj({ propId: str, rowIds: arr(uuid) }, ['propId']) },
  { method: 'get', path: '/admin/ai/settings', tag: 'AI', summary: 'AI provider, models, features, roles and budgets (the API key is never returned)', admin: true },
  { method: 'put', path: '/admin/ai/settings', tag: 'AI', summary: 'Update AI settings; apiKey is write-only (empty string clears it, requires ATRIUM_ENCRYPTION_KEY)', admin: true, body: obj({ enabled: bool, provider: { enum: ['anthropic', 'bedrock', 'mock', null] }, apiKey: str, bedrockRegion: str, models: obj({ smart: str, fast: str }), features: obj({ write: bool, chat: bool, autofill: bool, agents: bool }), allowedRoles: arr(role), monthlyBudgetUsd: num, perUserMonthlyBudgetUsd: num }) },
  { method: 'post', path: '/admin/ai/test', tag: 'AI', summary: 'Test the AI provider connection with a tiny request', admin: true },
  { method: 'get', path: '/admin/ai/usage', tag: 'AI', summary: 'AI spend by user, feature and day (estimated USD)', admin: true, query: { from: 'Start date (default: start of this month)', to: 'End date (default: now)' } },
];

const TAGS: [string, string][] = [
  ['Auth', 'Login, setup, invites, password reset'],
  ['SSO', 'OIDC single sign-on (e.g. AWS Cognito with Google) and provisioning settings'],
  ['Account', 'Your profile, devices, notification preferences and API tokens'],
  ['People', 'Members, groups and invites'],
  ['Admin', 'Workspace administration (owners and admins only): users, bulk invites, audit log, security settings, email'],
  ['Teamspaces', 'Teamspaces and their members'],
  ['Pages', 'Pages, content, trash, history, favorites'],
  ['Sharing', 'Page permissions, guests and publishing'],
  ['Comments', 'Comment threads and reactions'],
  ['Inbox', 'Notifications'],
  ['Databases', 'Databases, rows, properties and views'],
  ['Files', 'Uploads'],
  ['Realtime', 'WebSocket endpoints'],
  ['AI', 'In-app AI: writing help, workspace Q&A, agents and database autofill'],
  ['MCP', 'Model Context Protocol server for AI clients'],
  ['OAuth', 'OAuth 2.1 for MCP connectors'],
  ['SCIM', 'SCIM 2.0 user and group provisioning (served under /scim/v2)'],
  ['System', 'Health checks and API description'],
];

const paths: Record<string, any> = {};
for (const o of ops) {
  const params: any[] = [...o.path.matchAll(/\{(\w+)\}/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: str }));
  for (const [name, description] of Object.entries(o.query ?? {})) params.push({ name, in: 'query', required: false, description, schema: str });
  paths[o.path] ??= {};
  if (o.server) paths[o.path].servers = [{ url: o.server }];
  paths[o.path][o.method] = {
    tags: [o.tag],
    summary: o.admin ? `${o.summary} (admin only)` : o.summary,
    ...(o.description ? { description: o.description } : {}),
    ...(o.admin ? { 'x-admin-only': true } : {}),
    ...(o.public ? { security: [] } : {}),
    parameters: params,
    ...(o.body ? { requestBody: { content: { 'application/json': { schema: o.body } } } } : {}),
    responses: {
      200: { description: 'OK' },
      ...(o.public ? {} : { 401: { description: 'Unauthenticated' }, 403: { description: o.admin ? 'Not an admin' : 'Forbidden' } }),
      404: { description: 'Not found' },
    },
  };
}

export const openapi = {
  openapi: '3.1.0',
  info: {
    title: 'Atrium API',
    version: '1.1.0',
    description:
      'REST API for Atrium. Authenticate with `Authorization: Bearer <token>` using a personal API token from Settings → API tokens ' +
      '(or an OAuth access token from a connected app). Requests run with the permissions of the token owner. Browser sessions use a cookie; ' +
      'cookie-authenticated writes must come from the same origin. Database property values are keyed by property id (see GET /databases/{id}). ' +
      'Operations marked "admin only" require the owner or admin role.',
  },
  servers: [{ url: '/api/v1' }],
  tags: TAGS.map(([name, description]) => ({ name, description })),
  components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' }, session: { type: 'apiKey', in: 'cookie', name: 'atrium_session' } } },
  security: [{ bearer: [] }, { session: [] }],
  paths,
};
