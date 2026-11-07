# Atrium

A self-hosted, Notion-style workspace for teams of a few hundred people: a block editor with real-time
collaboration, nested pages, databases with views, comments, permissions and a REST API.

See `docs/PLAN.md` (architecture, feature inventory) and `docs/USER-STORIES.md`.

## Run locally (dev)

```bash
pnpm install
docker compose up -d db          # Postgres on :5460
pnpm dev                         # API on :3100, web on :5180
```

Open http://localhost:5180. The first visit asks you to create the owner account and workspace.
Optional demo data (with the server running): `pnpm --filter server seed`.

## Run with Docker

```bash
docker compose --profile full up -d --build
```

The app runs on http://localhost:3100. Data lives in the `dbdata` and `uploads` volumes. Back up with
`docker compose exec db pg_dump -U atrium atrium > backup.sql` plus a copy of the uploads volume.
Set `COOKIE_SECURE=true` when serving over HTTPS.

## Stack

- **Server**: Node 24, Fastify, PostgreSQL, Hocuspocus (Yjs) for live editing — one process.
- **Web**: React 19, Vite, BlockNote editor (ProseMirror/Yjs), TanStack Query.

## API

Create a token in Settings → API tokens, then:

```bash
curl -H "Authorization: Bearer atr_…" http://localhost:3100/api/v1/search?q=roadmap
curl -H "Authorization: Bearer atr_…" "http://localhost:3100/api/v1/pages/<id>/content?format=markdown"
curl -X PUT -H "Authorization: Bearer atr_…" -H 'content-type: application/json' \
  -d '{"markdown":"New paragraph","mode":"append"}' http://localhost:3100/api/v1/pages/<id>/content
```

API writes go through the live document, so anyone with the page open sees them instantly.
The full list of endpoints is at `/api/v1/openapi.json`.
