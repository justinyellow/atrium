# Notion parity audit

_Compiled 2026-11-05. Research only. Sources are linked inline. Many Notion help pages were only reachable as
localised copies or third-party mirrors, so menu names and plan tiers may have shifted. Where sources disagreed,
that's noted. Treat anything marked "(unverified)" as a lead to check, not a fact._

**What a real workspace typically looks like:** more than 10 teamspaces, with
a mix of owner and member roles, and several teamspaces archived in the trash. Teamspace structure,
teamspace-level permissions and archiving are therefore must-haves, as is importing teamspace structure.

Status key: ✅ done · 🟡 partial · ❌ missing. Effort: S (≤1 day) · M (2–5 days) · L (1–3 weeks).
Priority is for a 200–400 person internal team: **P0** blocks adoption · **P1** expected soon after · **P2** nice to have.

---

## 1. Feature inventory

### 1.1 Editor and pages

| Feature | What Notion does | Atrium | Effort | Pri | Notes / approach |
|---|---|---|---|---|---|
| Core blocks (text, H1–H3, lists, to-do, toggle, quote, divider, code, table, image/file/video/audio) | Standard block set | ✅ | – | P0 | BlockNote defaults. |
| H4, toggle headings | H4 added in 3.4 ([stork.ai](https://www.stork.ai/en/notion-3-4)) | 🟡 | S | P2 | Toggle headings work; H4 needs a heading level 4. |
| Callout, TOC, sub-page, columns, synced blocks, equations, breadcrumbs, buttons, bookmarks, embeds | Standard | ✅ | – | P0 | All built this session. Columns can't yet be *created* by dragging one block beside another. |
| Tabs block, HTML block | 3.4 tabs block; 3.6 HTML blocks (see [releases index](https://www.notion.com/releases)) | ❌ | M | P2 | Tabs = a layout block containing several "pages" of blocks. Allow HTML blocks only inside a sandboxed iframe. |
| Simple tables with merged cells | Merged cells (May 2026) | 🟡 | S | P2 | BlockNote supports `splitCells`; turn on merging in the UI. |
| Date mentions and reminders | `@today`, `@remind` | ✅ | – | P1 | Built this session. |
| Page / person mentions | `@` | ✅ | – | P0 | |
| Link previews / mentions of third-party URLs | "Paste as preview" for GitHub, Slack, Jira, Figma, Zoom, Linear, Trello… ([Notion help: link previews](https://www.notion.com/help/link-previews)) | 🟡 | M | P1 | We have generic bookmark unfurling. Provider-specific live previews need the integrations framework (§2). |
| Page icon, cover, full width, small text, lock | Standard | ✅ | – | P0 | |
| Font choice (Default/Serif/Mono) | Page style | ❌ | S | P2 | |
| Page history | Version history, restore | ✅ | – | P0 | No diff view yet (P2). |
| Page analytics (views, editors) | Per page, admin toggle ([Workspace settings](https://www.notion.com/help/workspace-settings)) | ❌ | S | P1 | `page_visits` already exists. Add a view log plus an "Updates" panel. |
| Wikis and verified pages | Wiki databases; page owner and verification with expiry | ❌ | M | P1 | Valuable for an internal knowledge base: a "Verified by X until Y" badge, owner property, expiry reminders. |
| Presentation mode | Present a page as slides (3.4, [stork.ai](https://www.stork.ai/en/notion-3-4)) | ❌ | M | P2 | Split on dividers or H1s. |
| Templates gallery | Page and DB templates, gallery | 🟡 | M | P1 | DB row templates done. Need page templates and a workspace template gallery. |
| Comments (inline, page, threads, resolve, reactions, mentions) | Standard | ✅ | – | P0 | Inline anchors are a text mark. |
| Suggested edits | Suggest-mode edits on pages (MCP exposes create/resolve suggested edit) | ❌ | L | P2 | Needs tracked-change marks. |
| Keyboard shortcuts | Extensive | 🟡 | S | P1 | Editor shortcuts come from BlockNote. Add the missing app-level ones (Ctrl+Shift+U back, Ctrl+[ ], Ctrl+Shift+P toggle peek, etc.). |
| Offline mode | Desktop/mobile apps only; opt-in per page; 50 DB rows ([9to5mac](https://9to5mac.com/2025/08/20/notion-offline-mode/), [release 2.53](https://notion.com/releases/2025-08-19)) | ❌ | L | P2 | Yjs makes offline editing feasible with IndexedDB (`y-indexeddb`) plus a service worker. |
| Mobile / desktop apps | Native apps | 🟡 | L | P1 | Responsive web only. Next steps: a PWA, then a Tauri/Electron desktop wrapper. |
| High-contrast mode | Accessibility setting (2026) | ❌ | S | P2 | |

### 1.2 Databases

| Feature | What Notion does | Atrium | Effort | Pri | Notes |
|---|---|---|---|---|---|
| Property types (incl. relation, rollup, formula, unique ID) | Standard | ✅ | – | P0 | Formula 2.0 is compatible. |
| Button property, status-group logic, "place" property | Button properties run actions per row; place property for map | ❌ | M | P1 | The button property reuses button-block actions. |
| Views: table, board, list, gallery, calendar, timeline | Standard | ✅ | – | P0 | |
| Chart view | Bar/line/donut charts from a DB ([help index](https://www.notion.com/help)) | ❌ | M | P1 | Group and aggregate on the server, render with a chart lib. |
| Dashboard view | Multiple widgets on one view (Mar 2026) | ❌ | L | P2 | Build after charts. |
| Map view | Plots a place property on a map | ❌ | M | P2 | Leaflet + OSM tiles, self-hostable. |
| Forms (form view / form builder) | Forms feeding a DB, public or internal; can be disabled by Enterprise admins ([Workspace settings](https://www.notion.com/help/workspace-settings)) | ❌ | M | P1 | High value internally (requests, intake). Form builder over the schema, with a public link option. |
| Sub-items and dependencies | Parent/child within a DB; dependency arrows on timeline ([2.19 release](https://www.notion.com/releases/2022-12-15)) | ❌ | M | P1 | A self-relation pair plus nested table rows plus timeline arrows. |
| Database automations | Triggers (page added, property edited, recurring) → actions (edit property, add page, Slack, mail, webhook); actions can't trigger automations ([Database automations](https://www.notion.com/help/database-automations)) | ❌ | L | **P0/P1** | Core of the integrations story. See §2. |
| Send-webhook action | POST to any URL; up to 5 per automation; no auth; pauses on failure ([Webhook actions](https://www.notion.com/en-gb/help/webhook-actions)) | ❌ | S | P1 | Do it better: HMAC signing, retries, a delivery log. |
| Multiple data sources per database | API 2025-09 "data sources" ([views guide](https://developers.notion.com/guides/data-apis/working-with-views.md)) | ❌ | L | P2 | Needed only for exact imports of multi-source DBs. Import each source as its own DB plus a linked view. |
| Database locking / "can create pages" permission | Lock schema; members can add rows without seeing others (Mar 2026, [theplanettools](https://theplanettools.ai/tools/notion)) | 🟡 | M | P1 | We have a page lock. Add a schema lock and row-level "only see own rows". |
| Inline and linked DBs | Standard | ✅ | – | P0 | Built this session. |
| Synced (third-party) databases | GitHub/Jira/Asana/GitLab repos and projects as read-only DBs, one-way sync ([GitHub guide](https://www.notion.com/help/guides/bring-your-codebase-into-context-with-notions-github-integration), [link previews & synced DBs](https://antonydiaz.me/help/link-previews-and-synced-databases)) | ❌ | L | P1 | Provider sync jobs; see §2. |
| Connected-file properties (Google Drive, Figma file) | A property type that previews files | ❌ | M | P2 | Comes with those integrations. |
| CSV import/export of a DB | Standard | ❌ | S | **P0** | Simple and expected. |
| Large DBs (10k+ rows) | Paginated, fast | 🟡 | M | P1 | We load all rows. Move filters/sorts into SQL and virtualise the table. |

### 1.3 Workspace, permissions and admin

| Feature | What Notion does | Atrium | Effort | Pri | Notes |
|---|---|---|---|---|---|
| Teamspaces (open/closed/private, owners, default access) | Standard | ✅ | – | P0 | Add "closed" and "private" teamspace types plus archive/restore of whole teamspaces. The real workspace has trashed teamspaces. |
| Groups | Standard | ✅ | – | P0 | |
| Guests and guest controls | Admins can block member-invited guests and require approval; per-teamspace override ([admin cheat sheet](https://notion.notion.site/Enterprise-admin-cheat-sheet-1b2efdeead0580a48196e4231033721e)) | 🟡 | S | P1 | Guests exist. Add the workspace toggle "members can invite guests" and request-to-add. |
| Sharing restrictions (disable public publish, disable export, disable moving pages out of the workspace) | Workspace security settings | ❌ | S | P1 | Workspace policy flags checked in the routes. |
| Link expiry on public pages | Paid plans | ❌ | S | P2 | `public_expires_at`. |
| SAML SSO | Business+ ([resumelens summary](https://www.resumelens.org/blog/notion/notion-enterprise-sso-scim), unverified tier) | ❌ | M | **P0** | Use OIDC/SAML against Google Workspace or Entra. OIDC first, which covers both. |
| SCIM provisioning plus group push | Enterprise | ❌ | M | P1 | SCIM 2.0 Users/Groups endpoints. Map groups to Atrium groups and teamspace membership. |
| Audit log | Enterprise; 90 days in the UI, longer via API ([howtoharden](https://howtoharden.com/guides/notion/), unverified) | ❌ | M | **P0** | Append-only table plus an admin UI plus a CSV/API export. Needed before rollout. |
| Workspace analytics | Member activity, page views, search analytics | ❌ | M | P2 | |
| Content search (admin) | Admins search all content, including private, for compliance | ❌ | S | P2 | Admin-only search that bypasses ACLs, written to the audit log. |
| Session policies, MFA, domain verification | Enterprise security | 🟡 | M | P1 | Rely on the IdP via SSO. Add session duration and a "force SSO" toggle. |
| Data residency | Enterprise | ✅ | – | – | Self-hosting gives this by default. |

### 1.4 Import / export

| Feature | Notion | Atrium | Effort | Pri | Notes |
|---|---|---|---|---|---|
| Import from Notion | n/a | 🟡 | L | **P0** | API importer designed and blocked on an integration token. Also add a **Notion export zip (HTML) importer** as a fallback, needing no token. |
| Import Confluence (Cloud zip), Evernote, Trello, Asana, Google Docs, Word, CSV, Markdown, HTML | Supported with caveats ([Import data](https://www.notion.com/help/import-data-into-notion)) | 🟡 Markdown only | M each | P1: Word, CSV, Confluence, Google Docs · P2: rest | Pluggable importer: each source converts to blocks + DB rows → the existing `blocksToDoc`. |
| Export: Markdown, HTML, PDF, CSV; whole-workspace export | Standard | 🟡 MD per page | M | P1 | Whole-workspace zip plus PDF (headless Chromium in the image). |

### 1.5 Notion AI

| Feature | Notion | Atrium | Effort | Pri | Notes |
|---|---|---|---|---|---|
| Inline AI (write, edit, summarise, translate) | Standard | ❌ | M | P1 | Planned (PLAN.md "Atrium AI"). |
| Q&A / Enterprise search across workspace and connectors | Business+ ([slite](https://slite.com/learn/how-to-use-notion-ai)) | ❌ | L | P1 | Permission-aware retrieval. Connectors reuse integration OAuth tokens. |
| AI connectors (Slack, Google Drive, GitHub, Jira, Linear, Teams, SharePoint/OneDrive, Salesforce, Box) | Read-only search over each tool, respecting source permissions ([GitHub connector](https://www.notion.com/connections/notion-ai-connector-for-github), [SharePoint connector](https://www.notion.com/en-gb/help/notion-ai-connector-for-microsoft-sharepoint-and-onedrive)) | ❌ | M each | P2 | Simplest approach: let the agent call each provider's API live with the user's linked account. Avoid copying all their data. |
| AI autofill properties | DB property filled by AI | ❌ | S | P1 | Haiku, run on row change. |
| AI meeting notes (transcription and summary) | No bot; can trigger agents ([slite](https://slite.com/learn/how-to-use-notion-ai)) | ❌ | L | P2 | Browser audio capture → transcription (self-hosted Whisper or a provider) → Claude summary. |
| Research mode (cited long reports, web + workspace) | Business ([slite](https://slite.com/learn/how-to-use-notion-ai)) | ❌ | M | P2 | Agent with web search plus workspace tools. |
| Custom agents (scheduled / triggered, write back to DBs) | 3.3, Feb 2026; credit-billed since May 2026 ([beginnersinai](https://beginnersinai.org/notion-ai-review/)) | ❌ | L | P1 | Same runtime as automations: trigger → agent run with tools → results. Per-agent budget. |
| Model picker | Several providers | ❌ | S | P2 | Provider abstraction (Anthropic / Bedrock / OpenAI-compatible). |
| External agents / "Claude and Cursor in Notion" | 3.6 (Jul 2026) | ❌ | – | P2 | Covered by our MCP server. |

### 1.6 Platform, API and dev

| Feature | Notion | Atrium | Effort | Pri | Notes |
|---|---|---|---|---|---|
| REST API with tokens | Public API | ✅ | – | P0 | |
| OAuth public integrations | OAuth for third-party apps | ❌ | M | P1 | Needed for the MCP OAuth flow anyway; build one OAuth 2.1 server for both. |
| API webhooks (event subscriptions) | Sparse events, HMAC-signed, retried ([v2 webhooks](https://developers.notion.com/reference/v2-webhooks), [Hookdeck guide](https://hookdeck.com/webhooks/platforms/guide-to-notion-webhooks-features-and-best-practices)) | ❌ | M | P1 | Subscribe to page/db/comment events → signed POST, retries, delivery log. |
| Hosted MCP server | `mcp.notion.com/mcp`, OAuth 2.1 + DCR, about 15 tools, no bearer tokens ([gamut](https://www.gamut.so/blog/notion-mcp-server-setup-guide), [Cequence](https://docs.aigateway.cequence.ai/docs/remote-mcp-servers/notion)) | 🟡 in progress | M | P0 | Ours should accept **both** OAuth (Claude.ai connectors) and bearer tokens, which suits headless/ECS use. |
| Developer platform / Workers (hosted code, webhooks in) | 3.5, May 2026 | ❌ | L | P2 | Skip. Use outbound webhooks plus external automation tools. |
| Notion Sites (publish with custom domain, SEO) | Paid ([Sites help](https://www.notion.com/help/category/notion-sites)) | 🟡 | M | P2 | We have public share links. A custom domain only needs a host-header mapping. |
| Notion Calendar | Separate app; calendar ↔ DB dates | ❌ | L | P2 | Calendar view plus an ICS feed per view (S, P1) covers most internal needs. |
| Notion Mail | **Shut down 22 Sep 2026** ([Wikipedia](https://en.wikipedia.org/wiki/Notion_(productivity_software))) | – | – | – | Don't build. |

---

## 2. Integrations

### 2.1 How Notion does it
- **Link previews**: paste a URL and choose "Paste as preview". It needs a per-user account link, and once one user authenticates, everyone who can view the page sees the preview ([link previews](https://www.notion.com/help/link-previews)).
- **Synced databases**: paste a repo/project/board URL and choose "Paste as database". It's a one-way, read-only sync. A Notion property with the same name as a provider field won't sync (GitHub, GitLab, Jira, Asana).
- **Connected properties**: e.g. a GitHub Pull Requests property that moves task status when the PR changes ([GitHub guide](https://www.notion.com/help/guides/bring-your-codebase-into-context-with-notions-github-integration)), and Google Drive and Figma file properties.
- **Slack**: automation and button action "Send Slack notification to #channel" (public channels only, rich text, variables). Notion links unfurl in Slack, and Slack message previews show in Notion. Each user connects their own Slack account. There's no central list of notification rules ([Slack help](https://notion.com/help/slack)).
- **Automations and webhooks**: DB triggers → actions, including Send webhook (POST, no auth, maximum 5 per automation, pauses on failure) ([webhook actions](https://www.notion.com/en-gb/help/webhook-actions)).
- **AI connectors**: a separate, AI-only read path into Slack, Drive, GitHub, Jira, Linear, Teams, SharePoint/OneDrive, Salesforce and Box. Admin-enabled, and it respects source permissions.
- **API webhooks and the public API**: used by Zapier, Make and others.

### 2.2 Recommended architecture for Atrium

```
              ┌────────────────── org admin ──────────────────┐
Settings → Integrations: enable a provider, enter its OAuth app
credentials (client id/secret, stored encrypted; Secrets Manager on ECS)
              └────────────────────────────────────────────────┘
                                    │
  integration_accounts (user ↔ provider tokens, encrypted, refresh) ◀── "Connect your GitHub" (per user)
                                    │
   ┌───────────────┬────────────────┼──────────────────┬──────────────────┐
 Unfurl providers  Synced DB jobs   Automation actions  Inbound webhooks   AI/MCP tools
 (URL pattern →    (provider →      (Slack msg, create  (GitHub/Slack/     (live API calls
  live preview      Atrium DB rows,  GitHub issue,       Jira events →      as the user)
  card + mention)   read-only cols,  webhook, email)     refresh synced
                    poll + webhooks)                     rows / triggers)
```

- **One generic framework** (`server/src/integrations/<provider>.ts`), each provider implementing any of:
  `oauth` (authorize URL, token exchange, refresh), `unfurl(url)`, `sync(source) → rows`, `actions[]`,
  `handleWebhook(req)`, `tools[]` (for AI and MCP).
- **Credentials**: OAuth apps are configured at org level by an admin. User tokens are stored per user, encrypted
  with a key from env/KMS. On ECS, provider secrets come from **Secrets Manager** env injection, so nothing is baked
  into the image.
- **Preview visibility** is a deliberate choice. Notion shows the linker's preview to every viewer, which can leak private
  repo data. Safer default: cache the preview as a snapshot when pasted, and refresh it live only for viewers who
  have linked their own account.
- **Synced DBs**: a background job queue (Postgres `SKIP LOCKED` table, which works across multiple ECS tasks)
  polls every N minutes plus provider webhooks. Provider fields are read-only columns, with extra Atrium
  properties allowed (avoiding Notion's name-collision trap by keeping provider fields namespaced).
- **Automations engine** (shared with buttons and custom agents): triggers (row added, property changed, schedule,
  inbound webhook, form submitted) → actions (edit property, add row, notify, Slack, webhook, run agent). Use loop
  protection like Notion's (automation-caused changes don't re-trigger), a run log per automation, and an admin
  page listing **all** automations (Notion lacks this).
- **Outbound webhooks**: HMAC-SHA256 signature header, retries with backoff, delivery log and replay. Better than
  Notion's unauthenticated POST.
- **Slack app** (one per org): bot token, `chat.postMessage` for notifications, `link_shared` event for
  unfurling Atrium links (needs a public Events URL; on ECS that's the ALB), slash command `/atrium` (search, create).

### 2.3 Build first (in order)
1. **Outbound webhooks plus the automations engine (with the send-webhook action).** Everything else plugs into it, and it lets
   Zapier, Make or n8n cover the long tail on day one.
2. **Slack.** Automation and button notifications to channels, Atrium link unfurls in Slack, Slack message
   previews in Atrium. This is the most-used integration internally.
3. **GitHub.** Link previews for PRs, issues and commits; a PR property that drives task status; repo issues/PRs as
   a synced DB. Development teams live there, so this is usually the first ask.
4. **Google Workspace.** OIDC SSO (P0 anyway), Drive file previews and a Drive file property, Calendar ICS feeds
   from calendar views. Many organisations use Google Workspace.
5. **Jira or Linear** (whichever the teams use): issue previews plus a synced DB.
6. **Figma**: live file previews and embeds. Cheap once unfurl providers exist.
7. **Microsoft Teams/SharePoint**, only if parts of the org use M365.
8. **Zoom / Google Meet**: meeting previews, later the source for AI meeting notes.

---

## 3. Things we overlooked (not in PLAN.md yet)
- **Database automations** and the **send-webhook action**: the foundation for Slack and other integrations, not just a feature.
- **Forms** (intake, requests), **chart and dashboard views**, **map view**.
- **Sub-items and dependencies** in DBs and timeline.
- **Wikis and verified pages** (owner, verification expiry): key for an internal knowledge base.
- **CSV import/export** of databases, **whole-workspace export**, **PDF export**, **Word / Confluence / Google Docs importers**.
- **Notion export-zip importer** as a no-token fallback to the API importer.
- **Audit log**, **SCIM**, workspace security toggles (disable export, disable public publish, guest controls), **admin content search**.
- **Teamspace types** (open/closed/private) and **teamspace archive/restore**. Real workspaces accumulate archived teamspaces.
- **Page analytics / "Updates" feed**, **workspace analytics**.
- **Page templates gallery** (not just DB templates).
- **API webhooks / event subscriptions** for external systems.
- **OAuth 2.1 authorization server**: needed by the MCP connector and future third-party apps.
- **ICS calendar feeds** from calendar views (a cheap stand-in for Notion Calendar).
- **Presentation mode**, **tabs block**, **suggested edits**, **high-contrast mode**.
- **Offline / PWA** and an installable desktop wrapper.
- **Background job runner** that is safe with several ECS tasks (Postgres-backed queue). The reminder interval job
  built today runs in every process. It claims atomically so it won't double-fire, but sync jobs and automations need a real queue.
- **Multi-instance collaboration on ECS**: Hocuspocus is in-memory per process. With more than one task you need either
  sticky sessions per document, or the Hocuspocus Redis extension (ElastiCache) so edits fan out across tasks. The
  `/api/v1/events` bus needs the same Redis pub/sub. The parallel ECS work has started this
  (`REDIS_URL` fan-out in `events.ts`); make sure the Hocuspocus document fan-out is covered too.
- **Don't build Notion Mail.** Notion is shutting it down on 22 Sep 2026.

## 4. Suggested roadmap (after MCP, ECS-readiness, Notion importer, Atrium AI)

**Phase A: rollout blockers (P0)**
OIDC/SAML SSO (Google Workspace / Entra) · audit log · CSV import/export · workspace security toggles ·
teamspace types and archive · multi-task ECS readiness (Redis fan-out for Hocuspocus and events, Postgres job queue) ·
DB pagination/SQL filtering for large databases.

**Phase B: automation and integrations core (P1)**
Automations engine (triggers/actions, run log, admin overview) · outbound webhooks (signed, retried) and API event
subscriptions · button property · Slack app · GitHub (previews, PR property, synced DB) · Google Drive previews ·
ICS feeds.

**Phase C: knowledge base and workflows (P1)**
Forms · wikis and verified pages · sub-items and dependencies · page templates gallery · page analytics and
updates · Word/Confluence/Google Docs importers · whole-workspace and PDF export · SCIM.

**Phase D: AI depth (P1/P2)**
AI autofill · custom agents on the automations engine · workspace Q&A with connector reads (GitHub/Slack/Drive via
linked accounts) · research mode · meeting notes.

**Phase E: polish (P2)**
Chart → dashboard views · map view · presentation mode · tabs/HTML blocks · suggested edits · offline/PWA and
desktop wrapper · Jira/Linear/Figma/Zoom/M365 · custom-domain sites.
