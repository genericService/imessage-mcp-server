import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { config } from './config.js';

/**
 * Secrets are read from the centralised config module rather than
 * `process.env` at module scope. See the note in `config.ts`: in ESM this
 * module body runs before `index.ts` had a chance to call `dotenv.config()`,
 * so reading env here directly meant a configured JWT_SECRET was ignored and
 * every restart silently invalidated all issued tokens.
 */
const JWT_SECRET = config.jwtSecret;
const DEFAULT_CLIENT_ID = config.oauthClientId;

export function getClientRegistry(): Map<string, string> {
  const registry = new Map<string, string>();
  if (config.oauthClientSecret) {
    registry.set(DEFAULT_CLIENT_ID, config.oauthClientSecret);
  }
  if (config.clientUbuntuSecret) {
    registry.set('ubuntu-remote', config.clientUbuntuSecret);
  }
  return registry;
}

/** Constant-time string comparison that tolerates unequal lengths. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    // Still hash both sides so the comparison cost does not leak length.
    const hashA = crypto.createHash('sha256').update(bufA).digest();
    const hashB = crypto.createHash('sha256').update(bufB).digest();
    crypto.timingSafeEqual(hashA, hashB);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
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

const MAX_AUTH_CODES = 1000;
const MAX_REFRESH_TOKENS = 5000;

/**
 * Drop expired entries, then enforce a hard cap.
 *
 * Both maps previously grew without bound: an authorization code was only
 * removed when redeemed, so unredeemed codes (any abandoned consent flow) and
 * every refresh token ever issued leaked for the lifetime of the process.
 * On a long-running server that is a slow, steady memory climb.
 */
function pruneStore<T extends { expiresAt: number }>(store: Map<string, T>, max: number): void {
  const now = Date.now();
  for (const [key, value] of store) {
    if (value.expiresAt <= now) store.delete(key);
  }
  if (store.size > max) {
    // Oldest-first eviction; Map preserves insertion order.
    const excess = store.size - max;
    let removed = 0;
    for (const key of store.keys()) {
      store.delete(key);
      if (++removed >= excess) break;
    }
  }
}

/** Periodic sweep so stores shrink even when no OAuth traffic arrives. */
let sweepTimer: NodeJS.Timeout | null = null;
export function startOAuthSweeper(intervalMs = 300_000): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    pruneStore(authCodes, MAX_AUTH_CODES);
    pruneStore(refreshTokens, MAX_REFRESH_TOKENS);
  }, intervalMs);
  sweepTimer.unref();
}

export function stopOAuthSweeper(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

export function getOAuthStoreStats() {
  return { authCodes: authCodes.size, refreshTokens: refreshTokens.size };
}

/** Escape untrusted values before interpolating them into the consent HTML. */
function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Only http(s) redirect targets; blocks javascript:/data: injection. */
function isSafeRedirectUri(uri: string): boolean {
  if (!uri) return false;
  try {
    const parsed = new URL(uri);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

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
    iss: `https://${config.publicDomain}`
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
    if (typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    if (!encodedHeader || !encodedPayload || !encodedSignature) return null;

    // Reject alg confusion (e.g. "none") before doing any signature work.
    const header = JSON.parse(base64UrlDecode(encodedHeader));
    if (!header || header.alg !== 'HS256') return null;

    const signatureInput = `${encodedHeader}.${encodedPayload}`;
    const expectedSignature = base64UrlEncode(crypto.createHmac('sha256', JWT_SECRET).update(signatureInput).digest());

    // `crypto.timingSafeEqual` THROWS on length mismatch. A token with a
    // short/truncated signature therefore used to raise instead of returning
    // null -- caught here previously only by luck of the try/catch, and a
    // crash risk anywhere this is called outside one.
    if (!safeEqual(encodedSignature, expectedSignature)) {
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
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
    code_challenge_methods_supported: ['S256', 'plain'],
    scopes_supported: ['imessage:read', 'imessage:write', 'imessage:all']
  };
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

  // Reject dangerous schemes (javascript:, data:) before rendering a form
  // that would post them straight back to us for a redirect.
  if (redirectUri && !isSafeRedirectUri(redirectUri)) {
    return res.status(400).send('Invalid redirect_uri. Only http(s) URLs are supported.');
  }

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
    p { color: #a3a3a3; font-size: 0.9rem; line-height: 1.5; }
    .client-box { background: #262626; padding: 12px; border-radius: 8px; font-size: 0.85rem; word-break: break-all; margin: 16px 0; color: #e5e5e5; }
    .btn { background: #d4a843; color: #0a0a0a; border: none; padding: 12px 20px; border-radius: 6px; font-weight: 600; cursor: pointer; width: 100%; font-size: 0.95rem; }
    .btn:hover { background: #e5b954; }
  </style>
</head>
<body>
  <div class="card">
    <h2>Authorize Client Access</h2>
    <p>An application is requesting access to your iMessage MCP Server.</p>
    <div class="client-box">
      <strong>Client ID:</strong> ${escapeHtml(clientId) || 'Default Client'}<br>
      <strong>Redirect URI:</strong> ${escapeHtml(redirectUri) || 'None'}
    </div>
    <form method="POST" action="/oauth/authorize">
      <input type="hidden" name="client_id" value="${escapeHtml(clientId)}">
      <input type="hidden" name="redirect_uri" value="${escapeHtml(redirectUri)}">
      <input type="hidden" name="state" value="${escapeHtml(state)}">
      <input type="hidden" name="code_challenge" value="${escapeHtml(codeChallenge)}">
      <input type="hidden" name="code_challenge_method" value="${escapeHtml(codeChallengeMethod)}">
      <button type="submit" class="btn">Approve & Grant Access</button>
    </form>
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
  // `req.body` is undefined if no body parser matched the content type;
  // destructuring it directly used to throw a TypeError and 500 the request.
  const body = (req.body ?? {}) as Record<string, unknown>;
  const client_id = body.client_id ? String(body.client_id) : '';
  const redirect_uri = body.redirect_uri ? String(body.redirect_uri) : '';
  const state = body.state ? String(body.state) : '';
  const code_challenge = body.code_challenge ? String(body.code_challenge) : '';
  const code_challenge_method = body.code_challenge_method ? String(body.code_challenge_method) : '';

  if (redirect_uri && !isSafeRedirectUri(redirect_uri)) {
    return res.status(400).json({ error: 'invalid_request', error_description: 'Invalid redirect_uri.' });
  }

  pruneStore(authCodes, MAX_AUTH_CODES);

  const code = `code_${crypto.randomBytes(16).toString('hex')}`;
  authCodes.set(code, {
    clientId: client_id || DEFAULT_CLIENT_ID,
    redirectUri: redirect_uri,
    codeChallenge: code_challenge || undefined,
    codeChallengeMethod: code_challenge_method || undefined,
    expiresAt: Date.now() + 10 * 60 * 1000 // 10 mins
  });

  if (redirect_uri) {
    try {
      const url = new URL(redirect_uri);
      url.searchParams.set('code', code);
      if (state) url.searchParams.set('state', state);
      return res.redirect(url.toString());
    } catch {
      // Malformed URI that slipped past validation: fall through to JSON
      // rather than letting `new URL` throw out of the handler.
      return res.status(400).json({ error: 'invalid_request', error_description: 'Malformed redirect_uri.' });
    }
  }

  res.json({ code, state, message: 'Authorization code generated successfully.' });
}

/**
 * OAuth 2.0 Token Endpoint (POST /oauth/token)
 */
export function handleTokenPost(req: Request, res: Response) {
  // Guard against an absent body (unparsed content type) which previously
  // threw a TypeError and returned an unhandled 500.
  const body = (req.body ?? {}) as Record<string, any>;
  const query = (req.query ?? {}) as Record<string, any>;

  const grantType = body.grant_type || query.grant_type;
  const clientId = body.client_id || query.client_id;
  let clientSecret = body.client_secret || query.client_secret;

  // RFC 6749 client_secret_basic: credentials in the Authorization header.
  const authHeader = req.headers.authorization || '';
  if (!clientSecret && authHeader.toLowerCase().startsWith('basic ')) {
    try {
      const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
      const idx = decoded.indexOf(':');
      if (idx !== -1) clientSecret = decoded.slice(idx + 1);
    } catch {
      /* malformed Basic header: fall through to invalid_client */
    }
  }

  // 1. Client Credentials Grant
  if (grantType === 'client_credentials') {
    const cid = String(clientId || DEFAULT_CLIENT_ID);
    const reqSecret = String(clientSecret || authHeader.replace(/^Bearer\s+/i, '') || '');
    const registry = getClientRegistry();
    const registeredSecret = registry.get(cid);
    const defaultSecret = config.oauthClientSecret;
    const expectedSecret = registeredSecret ?? defaultSecret;

    // Never authenticate against an empty expected secret, and compare in
    // constant time so the endpoint cannot be used as a timing oracle.
    if (!expectedSecret || !reqSecret || !safeEqual(reqSecret, expectedSecret)) {
      return res.status(401).json({ error: 'invalid_client', error_description: 'Invalid client credentials.' });
    }

    pruneStore(refreshTokens, MAX_REFRESH_TOKENS);

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
    const code = body.code || query.code;
    const codeVerifier = body.code_verifier || query.code_verifier;

    if (!code || !authCodes.has(code)) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'Invalid or expired authorization code.' });
    }

    const authData = authCodes.get(code)!;
    authCodes.delete(code);

    if (Date.now() > authData.expiresAt) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'Authorization code expired.' });
    }

    // Verify PKCE if present
    if (authData.codeChallenge) {
      if (!codeVerifier) {
        return res.status(400).json({ error: 'invalid_request', error_description: 'Missing code_verifier for PKCE.' });
      }
      let calculatedChallenge = String(codeVerifier);
      if (authData.codeChallengeMethod === 'S256') {
        calculatedChallenge = base64UrlEncode(crypto.createHash('sha256').update(String(codeVerifier)).digest());
      }
      if (!safeEqual(calculatedChallenge, authData.codeChallenge)) {
        return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed.' });
      }
    }

    pruneStore(refreshTokens, MAX_REFRESH_TOKENS);

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
    const refreshToken = body.refresh_token || query.refresh_token;
    if (!refreshToken || !refreshTokens.has(String(refreshToken))) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'Invalid refresh token.' });
    }

    const key = String(refreshToken);
    const refData = refreshTokens.get(key)!;
    if (Date.now() > refData.expiresAt) {
      refreshTokens.delete(key);
      return res.status(400).json({ error: 'invalid_grant', error_description: 'Refresh token expired.' });
    }

    // Rotate the refresh token so a leaked one has a bounded useful life.
    refreshTokens.delete(key);
    pruneStore(refreshTokens, MAX_REFRESH_TOKENS);
    const newRefreshToken = `ref_${crypto.randomBytes(24).toString('hex')}`;
    refreshTokens.set(newRefreshToken, { clientId: refData.clientId, expiresAt: refData.expiresAt });

    const accessToken = signJwt({ sub: refData.clientId, scope: 'imessage:all' }, 3600);
    return res.json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: newRefreshToken,
      scope: 'imessage:all'
    });
  }

  return res.status(400).json({ error: 'unsupported_grant_type', error_description: 'Supported grant_types: client_credentials, authorization_code, refresh_token.' });
}
