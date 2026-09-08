import crypto from 'crypto';
import { Request, Response } from 'express';
import { isRateLimited, recordAuthFailure } from './ratelimit.js';

const JWT_SECRET = process.env.JWT_SECRET || process.env.BEARER_TOKEN || crypto.randomBytes(32).toString('hex');
const DEFAULT_CLIENT_ID = process.env.OAUTH_CLIENT_ID || 'imessage-cli-client';

interface DynamicClient {
  clientId: string;
  clientSecret?: string;
  redirectUris: string[];
  tokenEndpointAuthMethod: string;
  clientName?: string;
  issuedAt: number;
}

/** In-memory RFC 7591 dynamic clients (Grok/Cursor OAuth connectors). */
const dynamicClients = new Map<string, DynamicClient>();

export function getClientRegistry(): Map<string, string> {
  const registry = new Map<string, string>();
  const defaultSecret = process.env.OAUTH_CLIENT_SECRET || process.env.BEARER_TOKEN;
  if (defaultSecret) {
    registry.set('imessage-cli-client', defaultSecret);
  }
  if (process.env.CLIENT_UBUNTU_SECRET) {
    registry.set('ubuntu-remote', process.env.CLIENT_UBUNTU_SECRET);
  }
  for (const [clientId, client] of dynamicClients.entries()) {
    if (client.clientSecret) {
      registry.set(clientId, client.clientSecret);
    }
  }
  return registry;
}

export function getDynamicClient(clientId: string): DynamicClient | undefined {
  return dynamicClients.get(clientId);
}

function adminSecret(): string {
  return process.env.BEARER_TOKEN || process.env.AUTH_TOKEN || '';
}

export function secretsEqual(provided: string, expected: string): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Master backend token from Authorization header or form field. */
function providedAdminToken(req: Request): string {
  const header = req.headers.authorization;
  if (header && /^Bearer\s+/i.test(header)) {
    return header.replace(/^Bearer\s+/i, '').trim();
  }
  const body = req.body || {};
  return String(body.admin_token || body.backend_token || '').trim();
}

function requireAdminToken(req: Request, res: Response): boolean {
  const expected = adminSecret();
  if (!expected) {
    res.status(500).json({ error: 'server_error', error_description: 'Backend token is not configured.' });
    return false;
  }
  if (!secretsEqual(providedAdminToken(req), expected)) {
    authFailure(req, res, 401, {
      error: 'unauthorized',
      error_description: 'Approval requires the backend bearer token.'
    });
    return false;
  }
  return true;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

interface AuthCodeData {
  clientId: string;
  redirectUri: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  expiresAt: number;
}

interface RefreshTokenData {
  clientId: string;
  expiresAt: number;
}

const authCodes = new Map<string, AuthCodeData>();
const refreshTokens = new Map<string, RefreshTokenData>();

/**
 * Base64URL Encoding helper for RFC 7515 JWTs
 */
function base64UrlEncode(str: string | Buffer): string {
  const buf = typeof str === 'string' ? Buffer.from(str) : str;
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64UrlDecode(str: string): string {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) base64 += '=';
  return Buffer.from(base64, 'base64').toString('utf8');
}

/**
 * Sign an HS256 JWT
 */
export function signJwt(payload: Record<string, any>, expiresInSeconds = 3600): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const fullPayload = {
    ...payload,
    iat: now,
    exp: now + expiresInSeconds,
    iss: 'https://imessage.genericservice.app'
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(fullPayload));
  const signatureInput = `${encodedHeader}.${encodedPayload}`;

  const signature = crypto.createHmac('sha256', JWT_SECRET).update(signatureInput).digest();
  const encodedSignature = base64UrlEncode(signature);

  return `${signatureInput}.${encodedSignature}`;
}

/**
 * Verify an HS256 JWT
 */
export function verifyJwt(token: string): Record<string, any> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    const signatureInput = `${encodedHeader}.${encodedPayload}`;

    const expectedSignature = base64UrlEncode(crypto.createHmac('sha256', JWT_SECRET).update(signatureInput).digest());

    const provided = Buffer.from(encodedSignature);
    const expected = Buffer.from(expectedSignature);
    if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
      return null;
    }

    const payload = JSON.parse(base64UrlDecode(encodedPayload));
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

export const SESSION_COOKIE_NAME = 'imessage_session';
export const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Validate logon credentials against configured username/password or master token fallback.
 */
export function validateLogonCredentials(username: string, password: string): boolean {
  if (!password) return false;

  const expectedUser = process.env.AUTH_USERNAME || 'admin';
  const expectedPass = process.env.AUTH_PASSWORD;
  const masterToken = process.env.BEARER_TOKEN || process.env.AUTH_TOKEN || '';

  // 1. Password check against configured AUTH_PASSWORD
  if (expectedPass && secretsEqual(password, expectedPass)) {
    if (!expectedUser || secretsEqual(username || expectedUser, expectedUser)) {
      return true;
    }
  }

  // 2. Backward compatibility: master BEARER_TOKEN accepted in password field
  if (masterToken && secretsEqual(password, masterToken)) {
    return true;
  }

  return false;
}

/**
 * Sign an HMAC-SHA256 session cookie for browser persistence.
 */
export function createSessionCookie(username: string): string {
  const payload = JSON.stringify({
    user: username,
    exp: Date.now() + SESSION_MAX_AGE_MS
  });
  const encodedPayload = base64UrlEncode(payload);
  const signature = crypto.createHmac('sha256', JWT_SECRET).update(encodedPayload).digest();
  const encodedSig = base64UrlEncode(signature);
  return `${encodedPayload}.${encodedSig}`;
}

/**
 * Verify and decode an HMAC-SHA256 session cookie.
 */
export function verifySessionCookie(cookieValue: string): { user: string; exp: number } | null {
  try {
    if (!cookieValue || !cookieValue.includes('.')) return null;
    const [encodedPayload, encodedSig] = cookieValue.split('.');
    if (!encodedPayload || !encodedSig) return null;

    const expectedSig = base64UrlEncode(crypto.createHmac('sha256', JWT_SECRET).update(encodedPayload).digest());
    if (!secretsEqual(encodedSig, expectedSig)) return null;

    const payload = JSON.parse(base64UrlDecode(encodedPayload));
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * Minimal request cookie header parser.
 */
export function parseCookies(req: Request): Record<string, string> {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return {};
  const cookies: Record<string, string> = {};
  for (const pair of cookieHeader.split(';')) {
    const idx = pair.indexOf('=');
    if (idx < 0) continue;
    const key = pair.substring(0, idx).trim();
    const val = pair.substring(idx + 1).trim();
    cookies[key] = decodeURIComponent(val);
  }
  return cookies;
}

/**
 * OAuth 2.0 Server Metadata Endpoint (RFC 8414)
 */
export function getOAuthMetadata(baseUrl: string) {
  return {
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/oauth/authorize`,
    token_endpoint: `${baseUrl}/oauth/token`,
    registration_endpoint: `${baseUrl}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'client_credentials', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: ['imessage:read', 'imessage:write', 'imessage:all']
  };
}

/**
 * OAuth 2.0 Protected Resource Metadata (RFC 9728) for MCP auth discovery.
 */
export function getProtectedResourceMetadata(baseUrl: string, resourcePath = '/mcp') {
  const resource = `${baseUrl}${resourcePath}`;
  return {
    resource,
    authorization_servers: [baseUrl],
    scopes_supported: ['imessage:read', 'imessage:write', 'imessage:all'],
    bearer_methods_supported: ['header'],
    resource_name: 'iMessage MCP Server',
    resource_documentation: `${baseUrl}/`
  };
}

/**
 * RFC 7591 Dynamic Client Registration (open for client apps using PKCE or client secrets).
 */
export function handleRegisterPost(req: Request, res: Response) {
  const body = req.body || {};
  const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : [];
  if (redirectUris.length === 0) {
    return res.status(400).json({
      error: 'invalid_client_metadata',
      error_description: 'redirect_uris is required and must be a non-empty array.'
    });
  }

  const authMethod = String(body.token_endpoint_auth_method || 'none');
  const isPublic = authMethod === 'none';
  const clientId = crypto.randomUUID();
  const issuedAt = Math.floor(Date.now() / 1000);
  const clientSecret = isPublic ? undefined : crypto.randomBytes(32).toString('hex');

  dynamicClients.set(clientId, {
    clientId,
    clientSecret,
    redirectUris,
    tokenEndpointAuthMethod: authMethod,
    clientName: body.client_name ? String(body.client_name) : undefined,
    issuedAt
  });

  res.setHeader('Cache-Control', 'no-store');
  return res.status(201).json({
    client_id: clientId,
    client_id_issued_at: issuedAt,
    client_secret: clientSecret,
    client_secret_expires_at: isPublic ? undefined : 0,
    redirect_uris: redirectUris,
    token_endpoint_auth_method: authMethod,
    grant_types: Array.isArray(body.grant_types) ? body.grant_types : ['authorization_code', 'refresh_token'],
    response_types: Array.isArray(body.response_types) ? body.response_types : ['code'],
    client_name: body.client_name || undefined
  });
}

/**
 * Render Authorization Consent Screen (GET /oauth/authorize)
 */
export function handleAuthorizeGet(req: Request, res: Response) {
  const clientId = String(req.query.client_id || '');
  const redirectUri = String(req.query.redirect_uri || '');
  const responseType = String(req.query.response_type || '');
  const state = String(req.query.state || '');
  const codeChallenge = String(req.query.code_challenge || '');
  const codeChallengeMethod = String(req.query.code_challenge_method || '');

  if (responseType !== 'code') {
    return res.status(400).send('Unsupported response_type. Must be "code".');
  }

  const dyn = getDynamicClient(clientId);
  const clientDisplayName = dyn?.clientName || clientId || 'Gemini Desktop / MCP Client';

  // Check for active session cookie
  const cookies = parseCookies(req);
  const sessionCookie = cookies[SESSION_COOKIE_NAME];
  const session = sessionCookie ? verifySessionCookie(sessionCookie) : null;
  const defaultUsername = process.env.AUTH_USERNAME || 'admin';

  const bodyContent = session ? `
    <h2>Authorize Client Access</h2>
    <p>Signed in as <strong style="color:#d4a843;">${escapeHtml(session.user)}</strong></p>
    <div class="client-box">
      <strong>Application:</strong> ${escapeHtml(clientDisplayName)}<br>
      <strong>Client ID:</strong> ${escapeHtml(clientId || 'Default Client')}<br>
      <strong>Redirect URI:</strong> ${escapeHtml(redirectUri || 'Loopback')}
    </div>
    <form method="POST" action="/oauth/authorize">
      <input type="hidden" name="client_id" value="${escapeHtml(clientId)}">
      <input type="hidden" name="redirect_uri" value="${escapeHtml(redirectUri)}">
      <input type="hidden" name="state" value="${escapeHtml(state)}">
      <input type="hidden" name="code_challenge" value="${escapeHtml(codeChallenge)}">
      <input type="hidden" name="code_challenge_method" value="${escapeHtml(codeChallengeMethod)}">
      <button type="submit" class="btn">Approve & Grant Access</button>
      <div style="margin-top:16px;text-align:center;">
        <a href="/oauth/logout?redirect_uri=${encodeURIComponent(req.originalUrl || req.url)}" style="color:#a3a3a3;font-size:0.8rem;text-decoration:none;">Log out or switch user</a>
      </div>
    </form>` : `
    <h2>Sign in to iMessage MCP</h2>
    <p>Enter your credentials to approve application access to iMessage.</p>
    <div class="client-box">
      <strong>Application:</strong> ${escapeHtml(clientDisplayName)}<br>
      <strong>Client ID:</strong> ${escapeHtml(clientId || 'Default Client')}
    </div>
    <form method="POST" action="/oauth/authorize">
      <input type="hidden" name="client_id" value="${escapeHtml(clientId)}">
      <input type="hidden" name="redirect_uri" value="${escapeHtml(redirectUri)}">
      <input type="hidden" name="state" value="${escapeHtml(state)}">
      <input type="hidden" name="code_challenge" value="${escapeHtml(codeChallenge)}">
      <input type="hidden" name="code_challenge_method" value="${escapeHtml(codeChallengeMethod)}">
      <label style="display:block;margin:0 0 6px;color:#a3a3a3;font-size:0.85rem;">Username</label>
      <input type="text" name="username" value="${escapeHtml(defaultUsername)}" required
        style="width:100%;box-sizing:border-box;margin-bottom:12px;padding:10px;border-radius:6px;border:1px solid #404040;background:#0a0a0a;color:#f5f0eb;">
      <label style="display:block;margin:0 0 6px;color:#a3a3a3;font-size:0.85rem;">Password</label>
      <input type="password" name="password" autocomplete="current-password" required
        style="width:100%;box-sizing:border-box;margin-bottom:12px;padding:10px;border-radius:6px;border:1px solid #404040;background:#0a0a0a;color:#f5f0eb;">
      <label style="display:flex;align-items:center;gap:8px;margin-bottom:16px;color:#a3a3a3;font-size:0.85rem;cursor:pointer;">
        <input type="checkbox" name="remember_me" value="true" checked style="accent-color:#d4a843;">
        Remember this browser for 30 days
      </label>
      <button type="submit" class="btn">Sign In & Authorize</button>
    </form>`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Authorize iMessage MCP Server</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0a0a0a; color: #f5f0eb; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
    .card { background: #171717; border: 1px solid #262626; border-radius: 12px; padding: 32px; width: 100%; max-width: 420px; box-shadow: 0 20px 25px -5px rgba(0,0,0,0.5); }
    h2 { margin-top: 0; color: #d4a843; font-size: 1.25rem; font-weight: 600; }
    p { color: #a3a3a3; font-size: 0.9rem; line-height: 1.5; margin-bottom: 16px; }
    .client-box { background: #262626; padding: 12px; border-radius: 8px; font-size: 0.85rem; word-break: break-all; margin: 16px 0; color: #e5e5e5; }
    .btn { background: #d4a843; color: #0a0a0a; border: none; padding: 12px 20px; border-radius: 6px; font-weight: 600; cursor: pointer; width: 100%; font-size: 0.95rem; }
    .btn:hover { background: #e5b954; }
  </style>
</head>
<body>
  <div class="card">
    ${bodyContent}
  </div>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html');
  res.send(html);
}

/**
 * Handle Authorization Submission (POST /oauth/authorize)
 */
export function handleAuthorizePost(req: Request, res: Response) {
  const { client_id, redirect_uri, state, code_challenge, code_challenge_method, username, password, admin_token, remember_me } = req.body;
  const clientId = String(client_id || DEFAULT_CLIENT_ID);
  const redirectUri = String(redirect_uri || '');

  // 1. Verify session or credentials
  const cookies = parseCookies(req);
  const sessionCookie = cookies[SESSION_COOKIE_NAME];
  const existingSession = sessionCookie ? verifySessionCookie(sessionCookie) : null;

  let authenticatedUser = existingSession?.user;

  if (!authenticatedUser) {
    const candidateUser = String(username || '').trim();
    const candidatePass = String(password || admin_token || '').trim();

    if (!validateLogonCredentials(candidateUser, candidatePass)) {
      authFailure(req, res, 401, {
        error: 'unauthorized',
        error_description: 'Invalid credentials. Enter valid username and password.'
      });
      return;
    }
    authenticatedUser = candidateUser || process.env.AUTH_USERNAME || 'admin';

    // Set 30-day session cookie if requested
    if (remember_me !== 'false') {
      const isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https' || process.env.USE_HTTPS === 'true';
      const cookieVal = createSessionCookie(authenticatedUser);
      res.setHeader('Set-Cookie', `${SESSION_COOKIE_NAME}=${encodeURIComponent(cookieVal)}; Path=/oauth; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_MS / 1000}${isSecure ? '; Secure' : ''}`);
    }
  }

  const dyn = getDynamicClient(clientId);
  if (dyn && redirectUri && !dyn.redirectUris.includes(redirectUri)) {
    return res.status(400).send('Invalid redirect_uri for registered client.');
  }

  const code = `code_${crypto.randomBytes(16).toString('hex')}`;
  authCodes.set(code, {
    clientId,
    redirectUri,
    codeChallenge: code_challenge,
    codeChallengeMethod: code_challenge_method,
    expiresAt: Date.now() + 10 * 60 * 1000 // 10 mins
  });

  if (redirectUri) {
    const url = new URL(redirectUri);
    url.searchParams.set('code', code);
    if (state) url.searchParams.set('state', state);
    return res.redirect(url.toString());
  }

  res.json({ code, state, message: 'Authorization code generated successfully.' });
}

/**
 * Handle Logout (GET /oauth/logout)
 */
export function handleLogoutGet(req: Request, res: Response) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE_NAME}=; Path=/oauth; HttpOnly; SameSite=Lax; Max-Age=0`);
  const redirectUri = req.query.redirect_uri || req.query.return_to;
  if (redirectUri && typeof redirectUri === 'string' && (redirectUri.startsWith('/') || redirectUri.startsWith('http'))) {
    return res.redirect(redirectUri);
  }
  res.send('<!DOCTYPE html><html><head><meta charset="utf-8"><title>Logged Out</title><style>body{font-family:sans-serif;background:#0a0a0a;color:#f5f0eb;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;}</style></head><body><div style="background:#171717;border:1px solid #262626;border-radius:12px;padding:32px;text-align:center;"><h2>Signed Out</h2><p style="color:#a3a3a3;">You have been logged out of iMessage OAuth sessions.</p></div></body></html>');
}

/**
 * OAuth 2.0 Token Endpoint (POST /oauth/token)
 */
function authFailure(req: Request, res: Response, status: number, body: Record<string, string>) {
  recordAuthFailure(req);
  if (isRateLimited(req)) {
    return res.status(429).json({ error: 'too_many_requests', error_description: 'Too many failed attempts, retry later.' });
  }
  return res.status(status).json(body);
}

export function handleTokenPost(req: Request, res: Response) {
  const grantType = req.body.grant_type || req.query.grant_type;
  const clientId = req.body.client_id || req.query.client_id;
  const clientSecret = req.body.client_secret || req.query.client_secret;

  // 1. Client Credentials Grant
  if (grantType === 'client_credentials') {
    const cid = clientId || DEFAULT_CLIENT_ID;
    const reqSecret = clientSecret || req.headers.authorization?.replace(/^Bearer\s+/i, '') || '';
    const registry = getClientRegistry();
    const registeredSecret = registry.get(cid);
    const defaultSecret = process.env.OAUTH_CLIENT_SECRET || process.env.BEARER_TOKEN;
    
    // Verify client credentials
    if (!secretsEqual(reqSecret, registeredSecret || defaultSecret || '')) {
      return authFailure(req, res, 401, { error: 'invalid_client', error_description: 'Invalid client credentials.' });
    }

    const accessToken = signJwt({ sub: clientId || DEFAULT_CLIENT_ID, scope: 'imessage:all' }, 3600);
    const refreshToken = `ref_${crypto.randomBytes(24).toString('hex')}`;
    refreshTokens.set(refreshToken, { clientId: clientId || DEFAULT_CLIENT_ID, expiresAt: Date.now() + 30 * 86400 * 1000 });

    return res.json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: refreshToken,
      scope: 'imessage:all'
    });
  }

  // 2. Authorization Code Grant
  if (grantType === 'authorization_code') {
    const code = req.body.code || req.query.code;
    const codeVerifier = req.body.code_verifier || req.query.code_verifier;
    const redirectUri = String(req.body.redirect_uri || req.query.redirect_uri || '');

    if (!code || !authCodes.has(code)) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'Invalid or expired authorization code.' });
    }

    const authData = authCodes.get(code)!;
    authCodes.delete(code);

    if (Date.now() > authData.expiresAt) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'Authorization code expired.' });
    }

    if (authData.redirectUri && redirectUri && authData.redirectUri !== redirectUri) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch.' });
    }

    // Public dynamic clients (auth method "none") skip client_secret; confidential clients must match.
    const dyn = getDynamicClient(authData.clientId);
    if (dyn?.clientSecret) {
      if (!secretsEqual(String(clientSecret || ''), dyn.clientSecret)) {
        return authFailure(req, res, 401, { error: 'invalid_client', error_description: 'Invalid client credentials.' });
      }
    }

    // Verify PKCE if present
    if (authData.codeChallenge) {
      if (!codeVerifier) {
        return res.status(400).json({ error: 'invalid_request', error_description: 'Missing code_verifier for PKCE.' });
      }
      let calculatedChallenge = codeVerifier;
      if (authData.codeChallengeMethod === 'S256') {
        calculatedChallenge = base64UrlEncode(crypto.createHash('sha256').update(codeVerifier).digest());
      }
      if (calculatedChallenge !== authData.codeChallenge) {
        return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed.' });
      }
    }

    const accessToken = signJwt({ sub: authData.clientId, scope: 'imessage:all' }, 3600);
    const refreshToken = `ref_${crypto.randomBytes(24).toString('hex')}`;
    refreshTokens.set(refreshToken, { clientId: authData.clientId, expiresAt: Date.now() + 30 * 86400 * 1000 });

    return res.json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: refreshToken,
      scope: 'imessage:all'
    });
  }

  // 3. Refresh Token Grant
  if (grantType === 'refresh_token') {
    const refreshToken = req.body.refresh_token || req.query.refresh_token;
    if (!refreshToken || !refreshTokens.has(refreshToken)) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'Invalid refresh token.' });
    }

    const refData = refreshTokens.get(refreshToken)!;
    if (Date.now() > refData.expiresAt) {
      refreshTokens.delete(refreshToken);
      return res.status(400).json({ error: 'invalid_grant', error_description: 'Refresh token expired.' });
    }

    const accessToken = signJwt({ sub: refData.clientId, scope: 'imessage:all' }, 3600);
    return res.json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'imessage:all'
    });
  }

  return res.status(400).json({ error: 'unsupported_grant_type', error_description: 'Supported grant_types: client_credentials, authorization_code, refresh_token.' });
}
