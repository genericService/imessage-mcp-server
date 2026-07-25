import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';

const JWT_SECRET = process.env.JWT_SECRET || process.env.BEARER_TOKEN || 'imessage-mcp-default-secret-key-change-me';
const DEFAULT_CLIENT_ID = process.env.OAUTH_CLIENT_ID || 'imessage-cli-client';
const DEFAULT_CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET || process.env.BEARER_TOKEN || '51efa996c0dd01bd562e90e1bdcec0064aece4b854ff15909b370057202c3a17';

export const CLIENT_REGISTRY = new Map<string, string>([
  ['imessage-cli-client', DEFAULT_CLIENT_SECRET],
  ['ubuntu-remote', process.env.CLIENT_UBUNTU_SECRET || 'REDACTED_UBUNTU_SECRET']
]);

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

    if (!crypto.timingSafeEqual(Buffer.from(encodedSignature), Buffer.from(expectedSignature))) {
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
      <strong>Client ID:</strong> ${clientId || 'Default Client'}<br>
      <strong>Redirect URI:</strong> ${redirectUri || 'None'}
    </div>
    <form method="POST" action="/oauth/authorize">
      <input type="hidden" name="client_id" value="${clientId}">
      <input type="hidden" name="redirect_uri" value="${redirectUri}">
      <input type="hidden" name="state" value="${state}">
      <input type="hidden" name="code_challenge" value="${codeChallenge}">
      <input type="hidden" name="code_challenge_method" value="${codeChallengeMethod}">
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
  const { client_id, redirect_uri, state, code_challenge, code_challenge_method } = req.body;

  const code = `code_${crypto.randomBytes(16).toString('hex')}`;
  authCodes.set(code, {
    clientId: client_id || DEFAULT_CLIENT_ID,
    redirectUri: redirect_uri,
    codeChallenge: code_challenge,
    codeChallengeMethod: code_challenge_method,
    expiresAt: Date.now() + 10 * 60 * 1000 // 10 mins
  });

  if (redirect_uri) {
    const url = new URL(redirect_uri);
    url.searchParams.set('code', code);
    if (state) url.searchParams.set('state', state);
    return res.redirect(url.toString());
  }

  res.json({ code, state, message: 'Authorization code generated successfully.' });
}

/**
 * OAuth 2.0 Token Endpoint (POST /oauth/token)
 */
export function handleTokenPost(req: Request, res: Response) {
  const grantType = req.body.grant_type || req.query.grant_type;
  const clientId = req.body.client_id || req.query.client_id;
  const clientSecret = req.body.client_secret || req.query.client_secret;

  // 1. Client Credentials Grant
  if (grantType === 'client_credentials') {
    const cid = clientId || DEFAULT_CLIENT_ID;
    const reqSecret = clientSecret || req.headers.authorization?.replace(/^Bearer\s+/i, '') || '';
    const registeredSecret = CLIENT_REGISTRY.get(cid);
    
    // Verify client credentials
    if (registeredSecret ? reqSecret !== registeredSecret : (reqSecret !== DEFAULT_CLIENT_SECRET)) {
      return res.status(401).json({ error: 'invalid_client', error_description: 'Invalid client credentials.' });
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
