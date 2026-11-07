/**
 * All runtime configuration, read once from the environment.
 * Same image for a single container (docker run / compose) and for ECS (many tasks) — only env differs.
 * See docs/DEPLOYMENT.md for the full table.
 */
import { join } from 'node:path';

const env = process.env;
const str = (k: string, d?: string) => (env[k] === undefined || env[k] === '' ? d : env[k]);
const num = (k: string, d: number) => {
  const v = str(k);
  if (v === undefined) return d;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Config: ${k} must be a number (got "${v}")`);
  return n;
};
const bool = (k: string, d: boolean) => {
  const v = str(k);
  return v === undefined ? d : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
};

function databaseUrl(): string {
  const url = str('DATABASE_URL');
  if (url) return url;
  // ECS usually injects the password as its own secret, so allow composing the URL from parts.
  const host = str('DB_HOST');
  if (!host) return 'postgres://atrium:atrium@localhost:5460/atrium'; // local dev default
  const user = encodeURIComponent(str('DB_USER', 'atrium')!);
  const pass = encodeURIComponent(str('DB_PASSWORD', '')!);
  return `postgres://${user}${pass ? `:${pass}` : ''}@${host}:${num('DB_PORT', 5432)}/${encodeURIComponent(str('DB_NAME', 'atrium')!)}`;
}

const storageDriver = str('STORAGE_DRIVER', 'local') as 'local' | 's3';
if (!['local', 's3'].includes(storageDriver)) throw new Error(`Config: STORAGE_DRIVER must be "local" or "s3"`);
if (storageDriver === 's3' && !str('S3_BUCKET', str('ASSETS_BUCKET'))) throw new Error('Config: S3_BUCKET (or ASSETS_BUCKET) is required when STORAGE_DRIVER=s3');

const logLevel = str('LOG_LEVEL', 'warn')!;
if (!['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'].includes(logLevel)) throw new Error(`Config: invalid LOG_LEVEL "${logLevel}"`);

export const config = {
  port: num('PORT', 3100),
  /** Public base URL, e.g. https://atrium.example.com (used for links, OAuth/MCP metadata). */
  publicUrl: str('PUBLIC_URL')?.replace(/\/$/, ''),
  logLevel,
  db: {
    url: databaseUrl(),
    /** DB_SSL=true for RDS. DB_SSL_REJECT_UNAUTHORIZED=false only if you can't supply the RDS CA bundle. */
    ssl: bool('DB_SSL', false),
    sslRejectUnauthorized: bool('DB_SSL_REJECT_UNAUTHORIZED', true),
    poolMax: num('DB_POOL_MAX', 20),
  },
  /** Optional. Required when running more than one task: syncs live editing + events across instances. */
  redisUrl: str('REDIS_URL'),
  storage: {
    driver: storageDriver,
    localDir: str('UPLOAD_DIR', join(process.cwd(), '..', 'data', 'uploads'))!,
    // ASSETS_BUCKET is accepted as an alias (some platforms inject it for a provisioned bucket).
    s3Bucket: str('S3_BUCKET', str('ASSETS_BUCKET')),
    s3Prefix: (str('S3_PREFIX', 'uploads/')!).replace(/^\//, ''),
    /** Credentials come from the default AWS chain (ECS task role, instance profile, env, ~/.aws). */
    awsRegion: str('AWS_REGION', str('AWS_DEFAULT_REGION', 'af-south-1')),
    /** Only for S3-compatible stores (MinIO etc.); leave unset for AWS. */
    s3Endpoint: str('S3_ENDPOINT'),
    s3ForcePathStyle: bool('S3_FORCE_PATH_STYLE', false),
  },
  setupToken: str('SETUP_TOKEN'),
  cookieSecure: bool('COOKIE_SECURE', false),
  /** Seconds to wait for in-flight work after SIGTERM (keep below the ECS stopTimeout, default 30s). */
  shutdownGraceSeconds: num('SHUTDOWN_GRACE_SECONDS', 20),
  // ----- admin (owned by routes/admin.ts) -----
  /** Days a page stays in Trash before it is permanently deleted (0 = keep forever). */
  trashRetentionDays: num('TRASH_RETENTION_DAYS', 30),
  // ----- AI (owned by server/src/ai/*; env takes precedence over the admin settings stored in the DB) -----
  ai: {
    /** anthropic | bedrock | mock (mock: deterministic, no network — dev/tests only). Unset = use the admin setting. */
    provider: str('AI_PROVIDER') as 'anthropic' | 'bedrock' | 'mock' | undefined,
    /** First-party key from the environment (e.g. an ECS secret). Never echoed by the API. */
    anthropicApiKey: str('ANTHROPIC_API_KEY'),
    /** 32 bytes (64 hex chars or base64). Required to store an API key in the database (AES-256-GCM). */
    encryptionKey: str('ATRIUM_ENCRYPTION_KEY'),
    bedrockRegion: str('AI_BEDROCK_REGION', str('AWS_REGION', str('AWS_DEFAULT_REGION'))),
    smartModel: str('AI_SMART_MODEL'),
    fastModel: str('AI_FAST_MODEL'),
  },
  // ----- email (owned by email.ts) -----
  email: {
    /** log (default: print to stdout) | ses (AWS SES v2 via default credential chain / ECS task role) | smtp */
    driver: (str('EMAIL_DRIVER', 'log') as 'log' | 'ses' | 'smtp'),
    from: str('EMAIL_FROM', 'Atrium <atrium@localhost>')!,
    sesRegion: str('SES_REGION', str('AWS_REGION', str('AWS_DEFAULT_REGION', 'af-south-1'))),
    sesConfigurationSet: str('SES_CONFIGURATION_SET'),
    smtpHost: str('SMTP_HOST'),
    smtpPort: num('SMTP_PORT', 587),
    smtpUser: str('SMTP_USER'),
    smtpPass: str('SMTP_PASS'),
    smtpSecure: bool('SMTP_SECURE', false),
    /** Local hour (server TZ) at which daily digests go out. */
    digestHour: num('EMAIL_DIGEST_HOUR', 8),
    /** Delay before "immediate" notification emails, so already-read notifications are skipped. */
    notificationDelaySeconds: num('EMAIL_NOTIFICATION_DELAY_SECONDS', 120),
  },
  // ----- SSO / provisioning (owned by sso.ts; see docs/DEPLOYMENT.md "SSO with Cognito") -----
  sso: {
    enabled: bool('SSO_ENABLED', false),
    /** OIDC issuer, e.g. https://cognito-idp.af-south-1.amazonaws.com/af-south-1_AbCdEf */
    // Falls back to COGNITO_REGION / COGNITO_USER_POOL_ID / COGNITO_CLIENT_ID, which some ECS platforms inject automatically.
    issuer: (str('SSO_ISSUER') ?? (str('COGNITO_USER_POOL_ID') && str('COGNITO_REGION') ? `https://cognito-idp.${str('COGNITO_REGION')}.amazonaws.com/${str('COGNITO_USER_POOL_ID')}` : undefined))?.replace(/\/$/, ''),
    clientId: str('SSO_CLIENT_ID', str('COGNITO_CLIENT_ID')),
    clientSecret: str('SSO_CLIENT_SECRET'),
    scopes: str('SSO_SCOPES', 'openid email profile')!,
    /** Cognito `identity_provider` hint (e.g. Google) to skip the hosted UI chooser. */
    idpHint: str('SSO_IDP_HINT'),
    buttonLabel: str('SSO_BUTTON_LABEL', 'Continue with Google')!,
    allowedDomains: ssoList(str('SSO_ALLOWED_DOMAINS')),
    /** Accept sign-ins from any email domain the IdP vouches for (default: allowed domains or existing users only). */
    allowAnyDomain: bool('SSO_ALLOW_ANY_DOMAIN', false),
    requireEmailVerified: bool('SSO_REQUIRE_EMAIL_VERIFIED', true),
    /** Disable password login for everyone except workspace owners (break-glass). */
    only: bool('SSO_ONLY', false),
    /**
     * Who may sign in with a password when SSO is enabled:
     *  external-only (default) — people whose email is on an SSO domain (SSO_ALLOWED_DOMAINS) must use SSO;
     *                            everyone else (guests, contractors, other domains) uses a password.
     *  allow    — anyone may use a password.
     *  sso-only — only owners and users an admin explicitly set to "password" may use a password.
     * SSO_ONLY=true is a legacy alias for sso-only. Per-user overrides live in users.signin_method.
     */
    passwordPolicy: (bool('SSO_ONLY', false) ? 'sso-only' : (str('SSO_PASSWORD_POLICY', 'external-only') as string)) as 'external-only' | 'allow' | 'sso-only',
    groupsClaim: str('SSO_GROUPS_CLAIM', 'cognito:groups')!,
    /** "atrium-admins=admin,atrium-guests=guest" — precedence admin > member > guest. */
    roleMap: ssoPairs(str('SSO_ROLE_MAP')),
    defaultRole: str('SSO_DEFAULT_ROLE', 'member')!,
    roleSync: bool('SSO_ROLE_SYNC', true),
    /**
     * IdP groups that grant access at all (any one is enough), e.g. "atrium@admin,atrium@user,atrium@guest,org@admin".
     * Essential when the user pool is shared with other audiences (customers, candidates): people without one of
     * these groups are refused at sign-in and deactivated by the Cognito sync. Empty = no group required.
     */
    requiredGroups: (str('SSO_REQUIRED_GROUPS') ?? '').split(',').map((g) => g.trim()).filter(Boolean),
    /** Mirror IdP groups into Atrium groups (only groups Atrium created from the IdP are managed). */
    groupSync: bool('SSO_GROUP_SYNC', false),
    /** Only sync IdP groups starting with this prefix (stripped for the Atrium group name). */
    groupPrefix: str('SSO_GROUP_PREFIX', '')!,
    /** "engineering=Engineering,finance=<teamspace-uuid>" — IdP group → teamspace membership. */
    teamspaceMap: ssoPairs(str('SSO_TEAMSPACE_MAP')),
    logoutUrl: str('SSO_LOGOUT_URL') ?? cognitoLogoutUrl(),
    cognito: {
      userPoolId: str('COGNITO_USER_POOL_ID'),
      region: str('COGNITO_REGION', str('AWS_REGION', str('AWS_DEFAULT_REGION', 'eu-west-1'))),
      syncIntervalMinutes: num('COGNITO_SYNC_INTERVAL', 15),
      dryRun: bool('COGNITO_SYNC_DRY_RUN', false),
      /** Abort a run that would deactivate more than this % of linked users (never fewer than 3 allowed). */
      maxDeactivatePct: num('COGNITO_SYNC_MAX_DEACTIVATE_PCT', 20),
    },
  },
};
function ssoList(v: string | undefined): string[] {
  return (v ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}
function ssoPairs(v: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of (v ?? '').split(',')) {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  }
  return out;
}
if (config.sso.enabled && (!config.sso.issuer || !config.sso.clientId)) throw new Error('Config: SSO_ENABLED requires SSO_ISSUER and SSO_CLIENT_ID');
if (!['admin', 'member', 'guest'].includes(config.sso.defaultRole)) throw new Error('Config: SSO_DEFAULT_ROLE must be admin, member or guest');
if (!['log', 'ses', 'smtp'].includes(config.email.driver)) throw new Error('Config: EMAIL_DRIVER must be log, ses or smtp');
if (config.email.driver === 'smtp' && !config.email.smtpHost) throw new Error('Config: SMTP_HOST is required when EMAIL_DRIVER=smtp');

export type Config = typeof config;

/**
 * Cognito hosted-UI logout, derived from the platform-injected COGNITO_DOMAIN (full URL or bare prefix),
 * so signing out of Atrium also ends the Cognito session. Needs PUBLIC_URL/login registered as a logout URL.
 */
function cognitoLogoutUrl(): string | undefined {
  const domain = str('COGNITO_DOMAIN');
  const clientId = str('SSO_CLIENT_ID', str('COGNITO_CLIENT_ID'));
  const publicUrl = str('PUBLIC_URL');
  if (!domain || !clientId || !publicUrl) return undefined;
  const region = str('COGNITO_REGION', str('AWS_REGION', 'eu-west-1'));
  const base = domain.startsWith('http') ? domain : domain.includes('.') ? `https://${domain}` : `https://${domain}.auth.${region}.amazoncognito.com`;
  return `${base.replace(/\/$/, '')}/logout?client_id=${encodeURIComponent(clientId)}&logout_uri=${encodeURIComponent(publicUrl.replace(/\/$/, '') + '/login')}`;
}
