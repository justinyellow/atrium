# User stories

Roles: **Owner** (installs/runs instance), **Admin**, **Member**, **Guest**, **Integration** (API client).

## Accounts & workspace
- US-01 As the first person to open a fresh install, I create the owner account and name the workspace.
- US-02 As an admin, I invite people by generating an invite link (optionally role-scoped) so they can sign up.
- US-03 As an admin, I change a member's role or deactivate them; deactivated users can't log in.
- US-04 As an admin, I create groups (e.g. "Finance") and teamspaces with their own members.
- US-05 As a user, I set my name, avatar and theme (light/dark/system).

## Sidebar & navigation
- US-10 As a user, I see a sidebar with Search, Home, Inbox, Settings, Favorites, Teamspaces, Shared, Private and Trash.
- US-11 I expand/collapse nested pages and drag pages to reorder or re-parent them.
- US-12 I hover a page to add a sub-page (+) or open its ⋯ menu (favorite, duplicate, rename, move, delete, copy link).
- US-13 I resize or collapse the sidebar; state persists.
- US-14 I press ⌘K / Ctrl+K to search pages by title and content and jump to them; recent pages show when empty.
- US-15 I see breadcrumbs in the top bar and can navigate to any ancestor.

## Pages & editor
- US-20 I type `/` to insert any block type (headings, lists, to-do, toggle, quote, callout, code, divider, table, image, file, sub-page, database).
- US-21 Markdown shortcuts work (`#`, `-`, `1.`, `[]`, `>`, ``` ``` ```, `---`).
- US-22 I drag blocks by the ⋮⋮ handle, and use it to delete, duplicate, turn into, or colour a block.
- US-23 Selecting text shows a toolbar: bold, italic, underline, strike, code, link, colour, comment.
- US-24 I add an emoji icon and a cover image to a page, and toggle full width / small text / lock.
- US-25 I type `@` to mention a person (notifies them) or a page (live link with its icon/title).
- US-26 I upload images and files by drag & drop or paste.
- US-27 I open page history, preview an older version, and restore it.
- US-28 I see pages that link to the current one (backlinks).
- US-29 I export a page as Markdown, and import a Markdown file as a new page.

## Real-time collaboration
- US-30 When two people edit the same page, changes appear instantly with coloured, named cursors.
- US-31 I see avatars of everyone currently viewing a page.
- US-32 Sidebar titles, icons, and database rows update live when others change them.

## Comments & inbox
- US-40 I comment on a whole page or on selected text; others reply in a thread.
- US-41 I resolve and re-open threads; resolved threads are hidden by default.
- US-42 I @-mention someone in a comment and they get an inbox notification.
- US-43 My Inbox lists mentions, replies, and shares; clicking one opens the page; I can mark all read.

## Databases
- US-50 I create a full-page database; it starts with Name, Tags, and a Table view.
- US-51 I add/rename/delete/retype properties: text, number, select, multi-select, status, date, person, checkbox, URL, email, phone, files, relation, rollup, formula, created/edited time & by, ID.
- US-52 I edit cells inline in a table, resize and reorder columns, and add rows at the bottom.
- US-53 I add views: table, board (grouped by select/status/person), list, gallery (card preview), calendar (by date), timeline (date range bars).
- US-54 Per view I set filters, sorts, grouping, visible properties; changes save to the view for everyone.
- US-55 I drag cards between board columns to change their status.
- US-56 I open a row as a side peek or full page and edit its properties and body content.
- US-57 Table footers show calculations (count, empty, sum, avg, min, max, % checked).
- US-58 I define row templates and create new rows from them.
- US-59 Relations link rows between two databases; rollups aggregate related values; formulas compute from properties.

## Permissions & sharing
- US-60 Pages in Private are visible only to me unless I share them.
- US-61 From Share I invite users/groups with Full access / Can edit / Can comment / Can view; sub-pages inherit.
- US-62 Users with view/comment access get a read-only editor; comment-only users can still comment.
- US-63 I publish a page to the web (read-only public link, no login).
- US-64 Guests only see pages explicitly shared with them.

## Trash
- US-70 Deleted pages go to Trash with their children; I can restore or delete forever; trash is searchable.

## API
- US-80 As an admin/member I create a personal integration token in Settings.
- US-81 As an integration I can: list/search pages, get/create/update/delete pages, read/write page content as Markdown or block JSON, query databases with filters/sorts, create/update rows, list users, create comments.
- US-82 API calls respect the token owner's permissions; an OpenAPI spec is served at `/api/v1/openapi.json`.

## Operations
- US-90 I run the stack with `docker compose up -d`; data persists in volumes; one env file configures it.
- US-91 A seed command creates a demo workspace for evaluation.
