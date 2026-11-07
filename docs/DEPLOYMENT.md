# Deploying Atrium

One Docker image runs everywhere. Only environment variables differ between targets.

| Target | Instances | Postgres | Redis | File storage |
|---|---|---|---|---|
| Laptop / single server (`docker run`, compose) | 1 | any Postgres 13+ | not needed | local volume |
| AWS ECS (Fargate or EC2) | 1–N tasks behind an ALB | RDS / Aurora PostgreSQL | ElastiCache (required for >1 task) | S3 |

The web app, REST API (`/api/v1`), live-editing WebSocket (`/collab`), event WebSocket (`/api/v1/events`)
and the MCP endpoint (`/mcp`) are all served by the same container on one port (default `3100`).

## Configuration

All settings come from the environment (`server/src/config.ts`). Startup fails fast on invalid values.

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3100` | Container port. |
| `PUBLIC_URL` | — | External base URL, e.g. `https://atrium.example.com`. Used for OAuth/MCP metadata and links. Set it everywhere except local dev. |
| `DATABASE_URL` | local dev DB | Full Postgres URL. If unset, it's built from the `DB_*` variables. |
| `DB_HOST` / `DB_PORT` / `DB_NAME` / `DB_USER` / `DB_PASSWORD` | — / `5432` / `atrium` / `atrium` / — | ECS-friendly: inject `DB_PASSWORD` as a secret. |
| `DB_SSL` | `false` | `true` for RDS. |
| `DB_SSL_REJECT_UNAUTHORIZED` | `true` | Set `false` only if you can't provide the RDS CA bundle (`NODE_EXTRA_CA_CERTS`). |
| `DB_POOL_MAX` | `20` | Per task. Keep `tasks × DB_POOL_MAX` under the RDS `max_connections`. |
| `REDIS_URL` | — | `redis://` or `rediss://` (TLS). **Required when running more than one task.** |
| `STORAGE_DRIVER` | `local` | `local` or `s3`. |
| `UPLOAD_DIR` | `/data/uploads` in the image | Local driver only — mount a volume here. |
| `S3_BUCKET` / `S3_PREFIX` | — / `uploads/` | S3 driver. Credentials come from the default AWS chain (the **ECS task role**); no keys needed. |
| `AWS_REGION` | `af-south-1` | Region for S3. |
| `S3_ENDPOINT` / `S3_FORCE_PATH_STYLE` | — / `false` | Only for S3-compatible stores (MinIO). Leave unset on AWS. |
| `SETUP_TOKEN` | — | If set, claiming the first owner account requires it. Always set on internet-reachable instances. |
| `COOKIE_SECURE` | `false` | `true` behind HTTPS. |
| `LOG_LEVEL` | `warn` | `info` logs every request (JSON lines on stdout). |
| `SHUTDOWN_GRACE_SECONDS` | `20` | Hard exit deadline after SIGTERM. Keep below the ECS `stopTimeout` (30s in the template). |

## Health checks

- `GET /api/v1/health` — liveness. Always 200 while the process runs. Use for the container health check.
- `GET /api/v1/ready` — readiness. 200 only when Postgres (and Redis and storage, if configured) respond and the task isn't
  draining; otherwise 503 with per-check detail. **Use this for the ALB target group health check.**

## How multi-instance works

- **Live editing:** with `REDIS_URL` set, Hocuspocus relays document updates and cursors between tasks through Redis, and
  takes a Redis lock so only one task writes a document to Postgres at a time. Two editors on different tasks see each other live.
- **Events** (sidebar/database/comment refresh) fan out over Redis pub/sub.
- **Background jobs** (date reminders) run only on the task holding a Postgres advisory lock. If that task stops, another
  takes over within 30 seconds. Each reminder is also claimed with `FOR UPDATE SKIP LOCKED`, so it fires once.
- **Schema migrations** run on boot behind an advisory lock, so tasks starting together don't race.
- **Login rate limiting** is stored in Postgres, so it applies across tasks.
- **Without Redis**, run exactly **one** task. Several tasks without Redis will split live editing between them.

## Graceful shutdown

On SIGTERM a task stops reporting ready, writes every open document to Postgres, closes WebSockets (clients reconnect to
another task automatically), then closes Redis and Postgres. Measured locally: about 1 second.

## Single server / single container

```bash
docker build -t atrium .
docker run -d --name atrium -p 3100:3100 \
  -e DATABASE_URL=postgres://atrium:…@db:5432/atrium \
  -e PUBLIC_URL=https://atrium.example.com -e COOKIE_SECURE=true -e SETUP_TOKEN=… \
  -v atrium_uploads:/data/uploads atrium
```

The proxy in front must pass WebSocket upgrades for `/collab` and `/api/v1/events`, and should allow long-lived connections
(nginx: `proxy_read_timeout 3600s`).

## AWS ECS

Templates are in `deploy/ecs/`:

- `task-definition.json` — Fargate, ARM64 (Graviton), 1 vCPU / 2 GB, `awslogs`, secrets from Secrets Manager. Replace the
  `<…>` placeholders. Adjust to EC2 launch type, x86 or SSM Parameter Store if that's the house standard.
- `task-role-policy.json` — least-privilege S3 access for uploads (objects under `uploads/` only).
- `execution-role-secrets-policy.json` — lets the execution role read the two secrets.

### Image

```bash
docker buildx build --platform linux/arm64,linux/amd64 -t <ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com/atrium:<TAG> --push .
```

The image runs as the non-root `node` user (uid 1000) and contains only production dependencies.

### Load balancer

- **Listener:** HTTPS 443 with the ACM certificate; one target group, target type `ip` (Fargate), port 3100.
- **Health check:** path `/api/v1/ready`, success code `200`, interval 15s, healthy threshold 2, unhealthy threshold 3.
- **Idle timeout:** at least **300 seconds**. Editors keep WebSockets open; the client sends keepalives, but short idle timeouts
  cause needless reconnects.
- **Deregistration delay:** 30 seconds (matches the shutdown grace).
- **Stickiness:** not needed **with Redis**. Without Redis keep the service at one task (stickiness alone isn't enough: two
  people editing one page could land on different tasks).
- **Routing:** send everything (`/*`) to the same target group. That includes `/mcp` and `/.well-known/*` for the MCP server
  and OAuth discovery. MCP requests are stateless HTTP, so they need no stickiness.

### Data services

- **RDS PostgreSQL 15+** (or Aurora PostgreSQL). Create the database and user; the app creates its tables on first boot.
  Set `DB_SSL=true`.
- **ElastiCache for Redis/Valkey**, cluster mode disabled, a single primary endpoint is enough. With in-transit encryption use
  a `rediss://` URL.
- **S3 bucket** for uploads, private, with Block Public Access on. Files are served through the app (permission-checked),
  never directly from S3.

### Security groups

ALB → tasks on 3100; tasks → RDS 5432, ElastiCache 6379, and S3 (gateway VPC endpoint recommended).

### Sizing

One task at 1 vCPU / 2 GB comfortably serves a few hundred users. Run two tasks across two AZs for availability (needs Redis).
Scale on CPU (target 60%) if needed.

## SSO with Cognito

Atrium signs people in with OIDC (authorization code + PKCE + nonce). A typical setup chains
**Atrium → Cognito user pool (managed login) → Google**, and **Cognito groups** decide each person's Atrium
role, groups and teamspaces. Login state lives in Postgres, so any ECS task can handle the callback.

### 1. Cognito user pool configuration

| Setting | Value |
|---|---|
| App client type | **Confidential** client (with client secret) — "Traditional web application". A public client also works (leave `SSO_CLIENT_SECRET` unset); PKCE is always used. |
| OAuth flow | **Authorization code grant** only (no implicit) |
| OpenID Connect scopes | `openid`, `email`, `profile` |
| Allowed callback URL | `https://<atrium host>/api/v1/auth/sso/callback` (exactly; shown in Settings → SSO & provisioning) |
| Allowed sign-out URL | `https://<atrium host>/login` (only if you set `SSO_LOGOUT_URL`) |
| Identity providers on the client | `Google` (and/or `COGNITO` if some people use pool passwords) |
| Domain | A Cognito domain or custom domain for managed login (the issuer stays `https://cognito-idp.<region>.amazonaws.com/<poolId>`) |
| Google IdP attribute mapping | `email` ← `email`, **`email_verified` ← `email_verified`**, `name` ← `name`, `given_name` ← `given_name`, `family_name` ← `family_name`, `username` ← `sub` |
| Groups | Create the groups you want to map (e.g. `atrium-admins`, `atrium-guests`, `atrium-team-eng`). Cognito puts them in the ID token as `cognito:groups` automatically. |

Without the `email_verified` mapping, federated Google users arrive with an unverified email and Atrium
refuses to create or link accounts by email (`SSO_REQUIRE_EMAIL_VERIFIED=true`, the safe default).

For **deprovisioning** (people disabled or removed in Cognito lose access within minutes even if they never
sign in again), give the ECS task role read access to the pool:

```json
{
  "Effect": "Allow",
  "Action": ["cognito-idp:ListUsers", "cognito-idp:ListGroups", "cognito-idp:ListUsersInGroup"],
  "Resource": "arn:aws:cognito-idp:<region>:<account>:userpool/<poolId>"
}
```

### 2. Atrium environment

| Variable | Example | Notes |
|---|---|---|
| `SSO_ENABLED` | `true` | |
| `SSO_ISSUER` | `https://cognito-idp.af-south-1.amazonaws.com/af-south-1_AbCdEf` | No trailing slash |
| `SSO_CLIENT_ID` | `4abc…` | Cognito app client id |
| `SSO_CLIENT_SECRET` | *(secret)* | Inject from Secrets Manager; omit for a public client |
| `SSO_IDP_HINT` | `Google` | Skips the Cognito chooser and goes straight to Google |
| `SSO_BUTTON_LABEL` | `Continue with Google` | |
| `SSO_SCOPES` | `openid email profile` | Default |
| `SSO_ALLOWED_DOMAINS` | `example.com` | Domains whose people auto-join as members. Admins can add more in Settings. Existing members can always sign in. |
| `SSO_ALLOW_ANY_DOMAIN` | `false` | `true` lets anyone the IdP authenticates join (only if the pool itself is restricted) |
| `SSO_REQUIRE_EMAIL_VERIFIED` | `true` | |
| `SSO_ONLY` | `true` | Password login and invite sign-up disabled; **owners** keep password login as break-glass (`/login?owner=1`) |
| `SSO_GROUPS_CLAIM` | `cognito:groups` | Default |
| `SSO_ROLE_MAP` | `atrium-admins=admin,atrium-guests=guest` | Highest match wins (admin > member > guest); owners are never changed |
| `SSO_DEFAULT_ROLE` | `member` | Role for people in no mapped group |
| `SSO_ROLE_SYNC` | `true` | Re-apply the mapped role on every login / sync |
| `SSO_GROUP_SYNC` | `true` | Mirror Cognito groups as Atrium groups (for sharing pages with a whole group) |
| `SSO_GROUP_PREFIX` | `atrium-team-` | Only mirror groups with this prefix; the prefix is stripped from the Atrium group name |
| `SSO_TEAMSPACE_MAP` | `atrium-team-eng=Engineering,atrium-team-fin=Finance` | Cognito group → teamspace (by name or id). Only memberships Atrium added are removed. |
| `SSO_LOGOUT_URL` | `https://<cognito domain>/logout?client_id=<id>&logout_uri=https://<host>/login` | Optional: also sign out of Cognito |
| `COGNITO_USER_POOL_ID` | `af-south-1_AbCdEf` | Enables the deprovisioning/group sync job |
| `COGNITO_REGION` | `af-south-1` | Defaults to `AWS_REGION` |
| `COGNITO_SYNC_INTERVAL` | `15` | Minutes; runs on one task only (jobs leader lock) |
| `COGNITO_SYNC_DRY_RUN` | `false` | Start with `true` and check Settings → SSO → Last run |
| `COGNITO_SYNC_MAX_DEACTIVATE_PCT` | `20` | A run that would deactivate more than this share of linked users (min 3) aborts and is audited |

### 3. What happens

- **First sign-in:** Atrium matches the Cognito `sub`, then a verified email (linking existing password accounts),
  otherwise creates the account if the email domain is allowed. SSO-created accounts have no usable password.
- **Every sign-in and every sync run:** the role, mirrored groups and mapped teamspaces are updated from Cognito groups.
  Everything is written to the audit log (`sso.*`).
- **Leavers:** the sync job deactivates people whose Cognito user is disabled or deleted and ends their sessions;
  re-enabling them in Cognito reactivates them. Owners and accounts without a Cognito link are never touched.
- **Rollout tip:** enable SSO with `SSO_ONLY=false` first so password users can sign in once with Google and get
  linked, run the sync in dry-run mode, then switch on `SSO_ONLY`.

### SCIM (other identity providers)

For Okta, Microsoft Entra ID, OneLogin and similar, use SCIM 2.0 instead of the Cognito sync:
base URL `https://<host>/scim/v2`, bearer token generated in Settings → SSO & provisioning. Supported:
Users (create, get, list with `userName`/`externalId`/`emails.value` `eq` filters, replace, patch incl. `active`,
delete = deactivate) and Groups (create, get, list with `displayName` filter, patch members add/remove/replace,
rename, delete). Owners cannot be deactivated via SCIM; deactivation ends the user's sessions.
