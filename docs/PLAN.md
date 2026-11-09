# Atrium — self-hosted Notion-style workspace

## Goal
A self-hostable workspace for one organisation (200–400 users) that matches Notion's
core experience: block editor, nested pages, sidebar, databases with views, real-time
collaboration, comments, permissions, and a public API. Runs with `docker compose up`.

## Non-goals (v1)
- Multi-tenant SaaS scale (thousands of orgs). One instance = one org, multiple workspaces allowed later.
- AI features, Notion Calendar/Mail, native mobile apps, offline mode.
- Pixel-perfect copy of Notion's brand. We match the *feel* (layout, density, interactions), not trademarks.

## Notion feature inventory (what we target)
Sourced from Notion help centre categories + release notes (3.x, 2025–2026).

| Area | Notion feature | v1 | Later |
|---|---|---|---|
| Editor | Text, H1–H3, bulleted/numbered/to-do lists, toggle, quote, callout, divider, code (syntax), image, file, video, audio, table, columns | ✅ | H4, tabs block, HTML block |
| Editor | `/` slash menu, drag handle (⋮⋮), block "turn into", markdown shortcuts, inline formatting toolbar, text/background colours | ✅ | |
| Editor | @-mentions: people, pages, dates; `[[` page links | ✅ (people, pages) | dates, reminders |
| Editor | Sub-page blocks, link-to-page, inline database | ✅ sub-page, link | inline DB |
| Editor | Synced blocks, buttons, table of contents, equations, embeds, breadcrumbs block | | ✅ |
| Pages | Icon (emoji), cover image, title, full width, small text, lock page | ✅ | font choice |
| Pages | Duplicate, move to, delete → trash → restore / delete forever | ✅ | |
| Pages | Page history (version snapshots, restore) | ✅ | diff view |
| Pages | Backlinks, page analytics (views, last edited) | ✅ backlinks | analytics |
| Pages | Templates | ✅ DB templates | template gallery |
| Sidebar | Workspace switcher, Search, Home, Inbox, Settings, Favorites, Teamspaces, Private, Shared, Trash, nested page tree with drag & drop, collapsible, resizable | ✅ | |
| Search | ⌘K quick find (titles + content), recent pages | ✅ | filters by author/date |
| Databases | Full-page databases, rows are pages | ✅ | inline |
| Databases | Properties: text, number (formats), select, multi-select, status, date (range), person, checkbox, URL, email, phone, files, relation, rollup, formula, created/edited time/by, unique ID | ✅ all but rollup/formula complete | formula 2.0 parity, button |
| Databases | Views: table, board, list, gallery, calendar, timeline | ✅ | chart, dashboard, form |
| Databases | Filters (AND, per type operators), sorts (multi), group by, hide/reorder properties, column widths, calculations (count/sum/avg) | ✅ | advanced filter groups |
| Databases | Row page: property panel + body; open as side peek / centre peek / full page | ✅ side peek + full | centre peek |
| Collab | Live multi-user editing, cursors with names, presence avatars | ✅ | |
| Collab | Comments: page-level + inline on text selection, threads, resolve, @mention | ✅ | reactions |
| Collab | Inbox / notifications (mentions, comment replies, page invites) | ✅ | email digest |
| Users | Sign up / login, invite by email link, profile, avatar, roles: owner/admin/member/guest | ✅ | SSO (OIDC), SCIM |
| Permissions | Per-page share: full access / can edit / can comment / can view; inherited by children; groups; teamspace membership; public "share to web" link | ✅ | |
| API | REST API with personal integration tokens: pages, blocks (markdown), databases, query, comments, users, search; OpenAPI doc | ✅ | webhooks |
| Import/export | Markdown export of a page; Markdown import | ✅ | Notion zip import, PDF |
| UI | Light/dark mode, keyboard shortcuts, Notion-like typography & density | ✅ | |

## Architecture

```
browser (React + BlockNote) ──HTTP /api──▶ Fastify API ──▶ PostgreSQL
        │                                       ▲
        └──── WebSocket /collab (Yjs) ──▶ Hocuspocus ─┘  (doc state stored as Yjs binary per page)
        └──── WebSocket /events  ──▶ event bus (sidebar/db/comment/notification invalidations)
```

- **Server**: Node 24 + TypeScript, Fastify, `pg`, Hocuspocus (Yjs) mounted on the same HTTP server.
  Single process is enough for 400 users; Postgres is the only state store (files on local disk volume).
- **Editor**: BlockNote (ProseMirror/TipTap) — gives Notion-style blocks, slash menu, drag handles, Yjs
  collaboration out of the box. We add custom blocks (sub-page, page mention) and theming.
- **Web**: Vite + React 19 + TanStack Query + Zustand; hand-written CSS mimicking Notion's spacing/typography.
- **Data model**
  - `users`, `sessions`, `api_tokens`, `workspaces`, `workspace_members(role)`, `groups`, `group_members`
  - `teamspaces`, `teamspace_members`
  - `pages(id, workspace_id, parent_id, parent_type[workspace|teamspace|page|database], title, icon, cover,
     position, is_database, database_id (for rows), properties jsonb, full_width, locked, created_by,
     updated_by, timestamps, deleted_at)`
  - `page_content(page_id, ydoc bytea, text tsvector-able plain text)` — Yjs is source of truth for body
  - `page_versions(page_id, ydoc, created_at, created_by)` — snapshot every N minutes of editing
  - `databases(page_id, schema jsonb)`; `database_views(id, database_id, type, name, config jsonb, position)`
  - `page_permissions(page_id, principal_type[user|group|public], principal_id, level)`
  - `comments(id, page_id, thread_id, block_id, quote, body, author, resolved, timestamps)`
  - `notifications`, `favorites`, `files`, `page_links` (backlinks)
- **Permissions**: effective level = max(workspace role default for teamspace/workspace pages, explicit grants
  on page or nearest ancestor). Private pages = only creator + explicit grants. Enforced in API and on
  Hocuspocus `onAuthenticate` (read-only connection for view/comment).
- **Search**: Postgres full-text (`tsvector`) over title + extracted plain text, updated on doc store.
- **API**: `/api/v1/*` same handlers as the app, auth by session cookie *or* `Authorization: Bearer <token>`.

## Phases
1. **Foundation** — repo, docker compose (Postgres), schema/migrations, auth, workspace, page CRUD, sidebar tree.
2. **Editor** — BlockNote + Hocuspocus live sync, persistence, presence, icons/covers, page menu, history.
3. **Databases** — schema, properties, table/board/list/gallery/calendar/timeline, filter/sort/group, row peek.
4. **Collaboration** — comments (page + inline), mentions, notifications/inbox, sharing & permissions UI.
5. **Platform** — search, trash, favorites, backlinks, templates, import/export, API tokens + OpenAPI, settings, dark mode.
6. **Hardening** — tests, seed data, Dockerfile, backups doc.

## Risks
- Inline comments anchored to Yjs text need relative positions — v1 anchors by block id + quoted text.
- Formula engine scope creep — v1 supports arithmetic, `prop()`, string concat, `if`, comparisons, date basics.
- BlockNote is MPL-2.0 for core (fine for internal use); its paid "XL" packages (PDF/DOCX export, AI) are avoided.

## Review & status (2026-11-05, end of first build session)

### Plan review — changes made while building
- **Rows are pages** (`pages.kind = 'row'`) rather than a separate table. That lets every row get an editor body, comments, history and permissions for free. The cost is that queries load every row of a database into memory; that's fine to a few thousand rows per database, but it needs SQL-side filtering or pagination beyond that.
- **Query evaluation is server-side in JS** (filters, sorts, formulas, rollups) so the REST API and the UI return identical results.
- **Inline comments** are a `comment` text mark holding the thread id, written by the commenter's editor. Comment-only users' threads are anchored by block id + quote, with no highlight.
- **Collab bug found & fixed:** BlockNote seeds an empty root block if it mounts before the first sync, which duplicated the root. The editor now mounts only after the sync, the server merges duplicate roots on load, and a version snapshot is taken automatically before any large deletion.

### Done (verified in browser or via curl)
Auth/setup/invites, roles, groups, teamspaces · sidebar (favorites, teamspaces, shared, private, drag-and-drop, rename, move, duplicate, trash) ·
Ctrl+K search · block editor with slash menu, callouts, sub-pages, TOC, @-mentions, uploads · live multi-user sync + presence ·
icons/covers/full width/small text/lock · version history + restore · backlinks · Markdown import/export ·
databases: 21 property types, formulas, two-way relations, rollups, table/board/list/gallery/calendar/timeline, filters/sorts/groups, calculations, templates, side peek ·
comments (inline + page, threads, resolve, reactions, mentions) · inbox notifications · share menu + publish to web · settings · API tokens + OpenAPI · dark mode.

### Known gaps / next phase
1. Inline (embedded) databases and linked database views.
2. Synced blocks, buttons, columns layout, equations, embeds, code syntax highlighting (`@blocknote/code-block`).
3. Teamspace/workspace icon pickers, notification email digests, OIDC SSO (important for 200+ users), SCIM.
4. Database scale: pagination/virtualised table, SQL-side filtering.
5. Notion import (zip of Markdown+CSV), PDF export.
6. Automated test suite (API integration tests + Playwright), CI, backups.
7. Hardening: rate limiting, CSRF token for cookie auth, audit log, file access checks per page.

## Next: AI and MCP (proposed 2026-11-05)

### Shared foundation: one tool layer
A single set of workspace tools (search, fetch page as Markdown, create/update/append page, query database,
create/update rows, manage properties and views, read/write comments, list users), always executed **as the
requesting user** through the existing permission checks. Both features below use it.

### 1. Atrium MCP server (do first)
- Remote MCP endpoint built into the server at `/mcp` (Streamable HTTP), exposing the tool layer.
- Auth: OAuth 2.1 so Claude.ai / Claude Desktop "Add custom connector" works with just the URL; API tokens
  (existing) as bearer auth for Claude Code and scripts.
- Tool names and shapes modelled on Notion's MCP so existing prompts and skills carry over.
- Also usable as a migration path: Notion MCP → Claude → Atrium MCP.

### 2. In-app AI ("Atrium AI")
- Org-level provider settings (admin only, key encrypted at rest, never sent to the browser). Anthropic by
  default; provider abstraction so AWS Bedrock (IAM, AWS billing) or a local OpenAI-compatible model can be used.
- Per-user/teamspace enablement, monthly budget caps, usage dashboard, audit log of agent actions.
- Features: inline "Ask AI" on selections (write, rewrite, summarise, translate, continue) streamed into the live
  doc; workspace Q&A with citations using permission-aware retrieval (Postgres full-text first, embeddings later);
  database AI autofill properties; agents that run multi-step tasks with the tool layer, showing each step and
  asking before destructive changes.
- Models: Opus for agents and Q&A, Haiku for autofill and short rewrites.

### Notion importer and sync
Settings → Import → Notion copies pages, databases (schemas, rows, views, templates), files, comments and people
through the official Notion API, recording every Notion id in `import_mappings` so re-runs update instead of
duplicating (`server/src/importers/notion`).

**Keep in sync** (one link per workspace) stores the integration secret encrypted (`ATRIUM_ENCRYPTION_KEY`) and keeps
Atrium as a one-way copy of Notion until it is unlinked — for running both side by side before a switch-over:
- Every N minutes (default 15): Notion search sorted by `last_edited_time` lists what changed since the last sync
  (with a 10-minute overlap); only those pages, rows and databases are re-read. New pages are added when they sit
  under something imported (or at the top level when the link covers everything shared with the integration).
- Every N hours (default 24), a full check lists everything and compares timestamps, catching anything the
  incremental pass missed. Imported objects Notion no longer lists are checked one by one; only those Notion reports
  as deleted go to the Atrium trash (restorable; brought back if restored in Notion). Objects the integration can no
  longer see are counted, never removed.
- Notion wins: edits made in Atrium to a synced page are replaced when that page next changes in Notion (the previous
  version stays in page history). A page deleted by someone in Atrium is not re-created. Synced pages show a banner.
- Known gaps: comments added in Notion arrive when their page next changes; moves of databases are not followed.
- Unlinking deletes the stored secret and stops syncing; all content stays in Atrium.
