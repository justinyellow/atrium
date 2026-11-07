create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  name text not null,
  password_hash text not null,
  avatar_url text,
  theme text not null default 'system',
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists sessions (
  token text primary key,
  user_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create table if not exists api_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  name text not null,
  token_hash text not null unique,
  prefix text not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);

create table if not exists workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  icon text,
  created_at timestamptz not null default now()
);

create table if not exists workspace_members (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role text not null check (role in ('owner','admin','member','guest')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create table if not exists invites (
  token text primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  role text not null,
  email text,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);

create table if not exists groups (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null
);
create table if not exists group_members (
  group_id uuid not null references groups(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  primary key (group_id, user_id)
);

create table if not exists teamspaces (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null,
  icon text,
  description text,
  is_default boolean not null default false,
  default_level text not null default 'edit',
  position double precision not null default 0,
  created_at timestamptz not null default now()
);
create table if not exists teamspace_members (
  teamspace_id uuid not null references teamspaces(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner','member')),
  primary key (teamspace_id, user_id)
);

create table if not exists pages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  parent_id uuid references pages(id) on delete cascade,
  teamspace_id uuid references teamspaces(id) on delete cascade,
  owner_id uuid references users(id),
  kind text not null default 'page' check (kind in ('page','database','row')),
  title text not null default '',
  icon text,
  cover text,
  cover_position double precision not null default 50,
  props jsonb not null default '{}',
  full_width boolean not null default false,
  small_text boolean not null default false,
  locked boolean not null default false,
  is_template boolean not null default false,
  position double precision not null default 0,
  created_by uuid references users(id),
  updated_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references users(id),
  public_slug text unique,
  auto_id bigserial
);
create index if not exists pages_parent_idx on pages(parent_id);
create index if not exists pages_ws_idx on pages(workspace_id, kind);

create table if not exists page_content (
  page_id uuid primary key references pages(id) on delete cascade,
  ydoc bytea not null,
  text text not null default '',
  updated_at timestamptz not null default now()
);
create index if not exists page_search_idx on pages using gin (to_tsvector('simple', title));
create index if not exists page_content_search_idx on page_content using gin (to_tsvector('simple', text));

create table if not exists page_versions (
  id uuid primary key default gen_random_uuid(),
  page_id uuid not null references pages(id) on delete cascade,
  ydoc bytea not null,
  title text not null default '',
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);
create index if not exists page_versions_idx on page_versions(page_id, created_at desc);

create table if not exists page_links (
  source_id uuid not null references pages(id) on delete cascade,
  target_id uuid not null references pages(id) on delete cascade,
  primary key (source_id, target_id)
);
create index if not exists page_links_target_idx on page_links(target_id);

create table if not exists page_permissions (
  id uuid primary key default gen_random_uuid(),
  page_id uuid not null references pages(id) on delete cascade,
  principal_type text not null check (principal_type in ('user','group','public','workspace')),
  principal_id uuid,
  level text not null check (level in ('view','comment','edit','full')),
  created_at timestamptz not null default now(),
  unique (page_id, principal_type, principal_id)
);
create index if not exists page_permissions_page_idx on page_permissions(page_id);

create table if not exists databases (
  page_id uuid primary key references pages(id) on delete cascade,
  schema jsonb not null default '[]'
);

create table if not exists database_views (
  id uuid primary key default gen_random_uuid(),
  database_id uuid not null references pages(id) on delete cascade,
  name text not null,
  type text not null,
  config jsonb not null default '{}',
  position double precision not null default 0
);

create table if not exists favorites (
  user_id uuid not null references users(id) on delete cascade,
  page_id uuid not null references pages(id) on delete cascade,
  position double precision not null default 0,
  primary key (user_id, page_id)
);

create table if not exists page_visits (
  user_id uuid not null references users(id) on delete cascade,
  page_id uuid not null references pages(id) on delete cascade,
  visited_at timestamptz not null default now(),
  primary key (user_id, page_id)
);

create table if not exists comment_threads (
  id uuid primary key default gen_random_uuid(),
  page_id uuid not null references pages(id) on delete cascade,
  block_id text,
  quote text,
  resolved boolean not null default false,
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);
create table if not exists comments (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references comment_threads(id) on delete cascade,
  author_id uuid references users(id),
  body text not null,
  reactions jsonb not null default '{}',
  created_at timestamptz not null default now(),
  edited_at timestamptz
);

create table if not exists notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  type text not null,
  actor_id uuid references users(id),
  page_id uuid references pages(id) on delete cascade,
  data jsonb not null default '{}',
  read_at timestamptz,
  archived boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists notifications_user_idx on notifications(user_id, created_at desc);

create table if not exists files (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references workspaces(id) on delete cascade,
  name text not null,
  mime text not null,
  size bigint not null,
  path text not null,
  uploaded_by uuid references users(id),
  created_at timestamptz not null default now()
);

-- Linked database views embedded in a page: views scoped to that block (null = the database's own views).
alter table database_views add column if not exists block_id text;
create index if not exists database_views_block_idx on database_views(block_id) where block_id is not null;

-- Editor blocks: synced blocks keep their content in hidden pages of kind 'synced'.
alter table pages drop constraint if exists pages_kind_check;
alter table pages add constraint pages_kind_check check (kind in ('page','database','row','synced'));

-- Date-mention reminders, synced from page content on each save.
create table if not exists reminders (
  id uuid primary key default gen_random_uuid(),
  page_id uuid not null references pages(id) on delete cascade,
  key text not null,
  user_id uuid references users(id) on delete cascade,
  date_value text not null,
  reminder text not null,
  due_at timestamptz not null,
  fired_at timestamptz,
  created_at timestamptz not null default now(),
  unique (page_id, key)
);
create index if not exists reminders_due_idx on reminders(due_at) where fired_at is null;

-- ---------- OAuth 2.1 (MCP connectors) ----------
create table if not exists oauth_clients (
  client_id text primary key,
  client_secret_hash text,
  name text not null,
  redirect_uris jsonb not null,
  created_at timestamptz not null default now()
);
create table if not exists oauth_codes (
  code_hash text primary key,
  client_id text not null references oauth_clients(client_id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  redirect_uri text not null,
  code_challenge text not null,
  scope text not null default 'mcp',
  resource text,
  expires_at timestamptz not null,
  used_at timestamptz
);
create table if not exists oauth_tokens (
  id uuid primary key default gen_random_uuid(),
  client_id text not null references oauth_clients(client_id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  access_hash text not null unique,
  refresh_hash text unique,
  scope text not null default 'mcp',
  access_expires_at timestamptz not null,
  refresh_expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);
create index if not exists oauth_tokens_user_idx on oauth_tokens(user_id, client_id);

-- Failed login attempts (rate limiting shared across instances)
create table if not exists login_attempts (
  key text not null,
  at timestamptz not null default now()
);
create index if not exists login_attempts_key_idx on login_attempts(key, at);

-- Audit log (admin-visible record of security-relevant actions)
create table if not exists audit_log (
  id bigserial primary key,
  workspace_id uuid references workspaces(id) on delete cascade,
  actor_id uuid references users(id) on delete set null,
  action text not null,
  target_type text,
  target_id text,
  meta jsonb not null default '{}',
  ip text,
  created_at timestamptz not null default now()
);
create index if not exists audit_log_ws_idx on audit_log(workspace_id, created_at desc);

-- ===== Admin agent: sessions metadata, workspace security settings, guest invites, offboarding =====
alter table sessions add column if not exists id uuid not null default gen_random_uuid();
alter table sessions add column if not exists user_agent text;
alter table sessions add column if not exists ip text;
alter table sessions add column if not exists last_seen_at timestamptz not null default now();
create unique index if not exists sessions_id_idx on sessions(id);
create index if not exists sessions_user_idx on sessions(user_id);
alter table workspaces add column if not exists settings jsonb not null default '{}';
-- Page grants applied when an email-bound (guest) invite is accepted: [{pageId, level}]
alter table invites add column if not exists page_grants jsonb not null default '[]';
alter table users add column if not exists deleted_at timestamptz;
alter table users add column if not exists last_active_at timestamptz;
create index if not exists audit_log_action_idx on audit_log(action, created_at desc);
create index if not exists audit_log_actor_idx on audit_log(actor_id, created_at desc);

-- ===== Email (outbox, password resets, notification preferences) =====
create table if not exists email_outbox (
  id bigserial primary key,
  to_addr text not null,
  subject text not null,
  text_body text not null,
  html_body text,
  headers jsonb not null default '{}',
  kind text not null default 'generic',
  notification_id uuid references notifications(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','sending','sent','failed','skipped')),
  attempts int not null default 0,
  send_after timestamptz not null default now(),
  last_error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index if not exists email_outbox_due_idx on email_outbox(send_after) where status = 'pending';

create table if not exists password_resets (
  token_hash text primary key,
  user_id uuid not null references users(id) on delete cascade,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists notification_prefs (
  user_id uuid primary key references users(id) on delete cascade,
  prefs jsonb not null default '{}',
  last_digest_at timestamptz
);

create table if not exists app_secrets (
  name text primary key,
  value text not null,
  created_at timestamptz not null default now()
);

-- ===== SSO / SCIM provisioning (sso.ts, routes/sso.ts, routes/scim.ts) =====
create table if not exists user_identities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  provider text not null,          -- OIDC issuer URL, or 'scim'
  subject text not null,           -- OIDC sub / SCIM externalId
  email text,
  username text,                   -- Cognito Username (for Admin APIs)
  created_at timestamptz not null default now(),
  last_login_at timestamptz,
  unique (provider, subject)
);
create index if not exists user_identities_user_idx on user_identities(user_id);
create table if not exists sso_states (
  state text primary key,
  code_verifier text not null,
  nonce text not null,
  redirect_to text,
  created_at timestamptz not null default now()
);
create table if not exists scim_tokens (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null default 'SCIM',
  token_hash text not null unique,
  prefix text not null,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
create table if not exists sso_sync_runs (
  id bigserial primary key,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  dry_run boolean not null default false,
  result jsonb not null default '{}'
);
alter table groups add column if not exists source text;           -- null = manual, 'sso' | 'scim' = IdP-managed
alter table groups add column if not exists external_id text;      -- IdP group name / SCIM externalId
alter table teamspace_members add column if not exists source text; -- 'sso' when added by group mapping
alter table users add column if not exists deactivated_by text;      -- 'sso' | 'scim' | 'admin'
alter table workspaces add column if not exists allowed_domains text[] not null default '{}';

-- Per-user sign-in method override: auto (follow workspace policy) | sso | password
alter table users add column if not exists signin_method text not null default 'auto';
do $$ begin
  alter table users add constraint users_signin_method_chk check (signin_method in ('auto','sso','password'));
exception when duplicate_object then null; end $$;

-- External sharing: password / expiry on public links, and account-less email shares
alter table page_permissions add column if not exists password_hash text;
alter table page_permissions add column if not exists password_version int not null default 0;
alter table page_permissions add column if not exists expires_at timestamptz;

create table if not exists external_shares (
  id uuid primary key default gen_random_uuid(),
  page_id uuid not null references pages(id) on delete cascade,
  email text not null,
  level text not null default 'view' check (level in ('view')),
  token_hash text not null unique,
  require_verification boolean not null default false,
  message text,
  expires_at timestamptz,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  last_accessed_at timestamptz,
  access_count int not null default 0,
  code_hash text,
  code_expires_at timestamptz,
  code_attempts int not null default 0
);
create index if not exists external_shares_page_idx on external_shares(page_id) where revoked_at is null;

create table if not exists external_share_sessions (
  token_hash text primary key,
  share_id uuid not null references external_shares(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  ip text,
  user_agent text
);
create index if not exists external_share_sessions_share_idx on external_share_sessions(share_id);

-- ===== In-app AI (server/src/ai/*) =====
create table if not exists ai_settings (
  workspace_id uuid primary key references workspaces(id) on delete cascade,
  settings jsonb not null default '{}',
  api_key_enc text,            -- AES-256-GCM with ATRIUM_ENCRYPTION_KEY; never plaintext
  api_key_last4 text,
  updated_at timestamptz not null default now()
);
create table if not exists ai_usage (
  id bigserial primary key,
  workspace_id uuid references workspaces(id) on delete cascade,
  user_id uuid references users(id) on delete set null,
  feature text not null,       -- write | chat | agent | autofill | test
  model text not null,
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  cache_read_tokens int not null default 0,
  cache_write_tokens int not null default 0,
  cost_usd numeric(14,6) not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists ai_usage_ws_idx on ai_usage(workspace_id, created_at);
create index if not exists ai_usage_user_idx on ai_usage(user_id, created_at);
create table if not exists ai_conversations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references workspaces(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  title text not null default 'New chat',
  mode text not null default 'ask',
  page_id uuid,
  api_messages jsonb not null default '[]',   -- append-only Messages API history (content blocks kept verbatim)
  transcript jsonb not null default '[]',     -- display messages for the UI
  pending jsonb,                               -- tool calls awaiting user confirmation
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists ai_conversations_user_idx on ai_conversations(user_id, updated_at desc);

-- DB fixes (2026-11-06): file ↔ page link (for future access checks), database default template + description
alter table files add column if not exists page_id uuid;
alter table files add column if not exists source_url text;
alter table databases add column if not exists default_template_id uuid;
alter table databases add column if not exists description text;

-- Importers (Notion): job records and source → Atrium id mappings (re-runs update instead of duplicating)
create table if not exists import_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references workspaces(id) on delete cascade,
  source text not null,
  status text not null default 'queued',
  dry_run boolean not null default false,
  options jsonb not null default '{}',
  progress jsonb not null default '{}',
  report jsonb,
  error text,
  started_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  heartbeat_at timestamptz
);
create index if not exists import_jobs_ws_idx on import_jobs(workspace_id, created_at desc);
create table if not exists import_mappings (
  source text not null,
  source_id text not null,
  atrium_id uuid not null,
  kind text not null,
  job_id uuid,
  source_last_edited timestamptz,
  meta jsonb,
  updated_at timestamptz not null default now(),
  primary key (source, source_id)
);
create index if not exists import_mappings_atrium_idx on import_mappings(atrium_id);

-- Importer settings saved per workspace + source (e.g. the Notion teamspace map), pre-filled on the next run.
create table if not exists import_settings (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  source text not null,
  key text not null,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, source, key)
);
