import dotenv from 'dotenv';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * Centralised, eagerly-loaded configuration.
 *
 * IMPORTANT (ESM evaluation order):
 * In ES modules every imported module body is evaluated *before* the importing
 * module's own body. Previously `dotenv.config()` lived in the body of
 * `index.ts`, while `oauth.ts` read `process.env.JWT_SECRET` at module scope.
 * Because `index.ts` imports `oauth.ts`, the OAuth module was initialised
 * BEFORE dotenv ever populated `process.env` -- so a `.env`-provided
 * `JWT_SECRET` was silently ignored and replaced by a random per-boot secret.
 * The practical effect: every restart invalidated all previously issued OAuth
 * access tokens, and clients saw random 403s until they re-authenticated.
 *
 * This module is the single place that loads dotenv, and every other module
 * imports its values from here. Because `config.ts` is a dependency of both
 * `index.ts` and `oauth.ts`, it is guaranteed to be evaluated first.
 */

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

dotenv.config({ path: path.join(PACKAGE_ROOT, '.env') });

/** Collected non-fatal configuration problems, surfaced at boot and on /health. */
const warnings: string[] = [];

export function getConfigWarnings(): readonly string[] {
  return warnings;
}

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    warnings.push(`${name}="${raw}" is not a valid integer; falling back to ${fallback}.`);
    return fallback;
  }
  if (parsed < min || parsed > max) {
    const clamped = Math.min(Math.max(parsed, min), max);
    warnings.push(`${name}=${parsed} is outside [${min}, ${max}]; clamped to ${clamped}.`);
    return clamped;
  }
  return parsed;
}

function envBool(name: string, fallback = false): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return ['true', '1', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/**
 * The master bearer token. When absent we still boot (so a misconfigured
 * deploy degrades to "nobody can authenticate" rather than "process exits"),
 * but we generate an ephemeral token and warn loudly, because every restart
 * will invalidate existing clients.
 */
const configuredAuthToken = process.env.BEARER_TOKEN || process.env.AUTH_TOKEN || '';
const PLACEHOLDER_TOKENS = new Set(['change-me-to-a-secure-random-token', 'changeme', 'secret', 'token']);

if (!configuredAuthToken) {
  warnings.push(
    'No BEARER_TOKEN/AUTH_TOKEN configured. A random ephemeral token was generated; ' +
      'it changes on every restart and all clients must be reconfigured. Set one in .env.'
  );
} else if (PLACEHOLDER_TOKENS.has(configuredAuthToken.toLowerCase())) {
  warnings.push('BEARER_TOKEN/AUTH_TOKEN is still set to a placeholder value. Replace it with a strong random secret.');
} else if (configuredAuthToken.length < 16) {
  warnings.push('BEARER_TOKEN/AUTH_TOKEN is shorter than 16 characters; use a longer random secret.');
}

const configuredJwtSecret = process.env.JWT_SECRET || configuredAuthToken;
if (!process.env.JWT_SECRET && !configuredAuthToken) {
  warnings.push('No JWT_SECRET configured; OAuth tokens are signed with an ephemeral per-boot secret.');
}

/**
 * Legacy transition token. Historically this value was hardcoded in source,
 * which meant a full-access credential was committed to git. It is now opt-in
 * via the LEGACY_TOKEN environment variable so nothing breaks for existing
 * deployments while the secret leaves the repository.
 */
const legacyToken = process.env.LEGACY_TOKEN || '';
if (legacyToken) {
  warnings.push('LEGACY_TOKEN is enabled. This is a transitional full-access credential; migrate clients and remove it.');
}

export const config = Object.freeze({
  port: envInt('PORT', 8765, 1, 65535),
  useHttps: envBool('USE_HTTPS', false),
  publicDomain: process.env.PUBLIC_DOMAIN || 'imessage.genericservice.app',

  authToken: configuredAuthToken || crypto.randomBytes(32).toString('hex'),
  authTokenIsEphemeral: !configuredAuthToken,
  jwtSecret: configuredJwtSecret || crypto.randomBytes(32).toString('hex'),
  legacyToken,

  oauthClientId: process.env.OAUTH_CLIENT_ID || 'imessage-cli-client',
  oauthClientSecret: process.env.OAUTH_CLIENT_SECRET || process.env.BEARER_TOKEN || '',
  clientUbuntuSecret: process.env.CLIENT_UBUNTU_SECRET || '',

  pythonBin: process.env.PYTHON_BIN || '/usr/bin/python3',
  cliPath: process.env.IMESSAGE_CLI_PATH || path.join(PACKAGE_ROOT, 'bin', 'imessage'),

  // Subprocess resilience. Without timeouts a wedged AppleScript/GUI prompt
  // pins a request open forever and leaks the MCP session behind it.
  readTimeoutMs: envInt('CLI_READ_TIMEOUT_MS', 30_000, 1_000, 600_000),
  sendTimeoutMs: envInt('CLI_SEND_TIMEOUT_MS', 90_000, 1_000, 600_000),
  attachmentTimeoutMs: envInt('CLI_ATTACHMENT_TIMEOUT_MS', 60_000, 1_000, 600_000),
  // base64 of a large video easily exceeds Node's 1 MB execFile default (ENOBUFS).
  cliMaxBufferBytes: envInt('CLI_MAX_BUFFER_BYTES', 128 * 1024 * 1024, 1024 * 1024, 1024 * 1024 * 1024),
  maxConcurrentCli: envInt('MAX_CONCURRENT_CLI', 4, 1, 64),

  // Session lifecycle
  sessionIdleMs: envInt('SESSION_IDLE_MS', 300_000, 10_000, 86_400_000),
  sessionSweepMs: envInt('SESSION_SWEEP_MS', 60_000, 1_000, 3_600_000),
  maxHttpSessions: envInt('MAX_HTTP_SESSIONS', 256, 1, 100_000),
  maxSseSessions: envInt('MAX_SSE_SESSIONS', 256, 1, 100_000),
  confirmTokenTtlMs: envInt('CONFIRM_TOKEN_TTL_MS', 600_000, 10_000, 86_400_000),
  maxPendingConfirmTokens: envInt('MAX_PENDING_CONFIRM_TOKENS', 512, 1, 100_000),

  // HTTP hardening
  bodyLimit: process.env.BODY_LIMIT || '1mb',
  requestTimeoutMs: envInt('REQUEST_TIMEOUT_MS', 120_000, 1_000, 600_000),
  keepAliveTimeoutMs: envInt('KEEP_ALIVE_TIMEOUT_MS', 76_000, 1_000, 600_000),
  headersTimeoutMs: envInt('HEADERS_TIMEOUT_MS', 80_000, 1_000, 600_000),
  shutdownGraceMs: envInt('SHUTDOWN_GRACE_MS', 15_000, 100, 300_000),

  // Brute-force protection on authenticated endpoints
  rateLimitWindowMs: envInt('RATE_LIMIT_WINDOW_MS', 60_000, 1_000, 3_600_000),
  rateLimitMax: envInt('RATE_LIMIT_MAX', 600, 1, 1_000_000),
  authFailLimitWindowMs: envInt('AUTH_FAIL_WINDOW_MS', 900_000, 1_000, 86_400_000),
  authFailLimitMax: envInt('AUTH_FAIL_MAX', 25, 1, 100_000),
  trustProxy: envBool('TRUST_PROXY', true),

  enableAuditLog: envBool('ENABLE_AUDIT_LOG', false),
  auditMaxBytes: envInt('AUDIT_MAX_BYTES', 10 * 1024 * 1024, 4096, 1024 * 1024 * 1024),
  auditMaxFiles: envInt('AUDIT_MAX_FILES', 5, 1, 100),

  isTest: process.env.NODE_ENV === 'test'
});

export type AppConfig = typeof config;
