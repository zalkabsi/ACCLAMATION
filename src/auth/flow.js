import { writeFileSync, chmodSync } from 'node:fs';
import { ALL_SCOPES } from '../config.js';

/**
 * Authorization Code flow, done on localhost so tokens never leave the machine.
 * Twitch requires the redirect URI to match the app registration exactly.
 */

const AUTHORIZE = 'https://id.twitch.tv/oauth2/authorize';
const TOKEN = 'https://id.twitch.tv/oauth2/token';
const VALIDATE = 'https://id.twitch.tv/oauth2/validate';

export function buildAuthorizeUrl({ clientId, redirectUri, state, scopes = ALL_SCOPES, forceVerify = true }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopes.join(' '),
    state,
  });
  if (forceVerify) params.set('force_verify', 'true');
  return `${AUTHORIZE}?${params.toString()}`;
}

export async function exchangeCode({ clientId, clientSecret, code, redirectUri, fetchImpl = globalThis.fetch }) {
  const response = await fetchImpl(TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    }),
  });
  return handleTokenResponse(response);
}

export async function refreshToken({ clientId, clientSecret, refreshToken: token, fetchImpl = globalThis.fetch }) {
  const response = await fetchImpl(TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
      refresh_token: token,
    }),
  });
  return handleTokenResponse(response);
}

async function handleTokenResponse(response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.message || `token request failed (${response.status})`);
  }
  return body;
}

/** Turn a token response into the file shape the app reads. */
export async function describeToken(tokenResponse, { fetchImpl = globalThis.fetch } = {}) {
  const validation = await fetchImpl(VALIDATE, {
    headers: { authorization: `OAuth ${tokenResponse.access_token}` },
  }).then((response) => response.json());
  if (!validation?.user_id) throw new Error('could not validate the freshly issued token');
  const expiresAt = new Date(Date.now() + (tokenResponse.expires_in ?? 3600) * 1000).toISOString();
  return {
    access_token: tokenResponse.access_token,
    refresh_token: tokenResponse.refresh_token ?? null,
    expires_at: expiresAt,
    scopes: Array.isArray(validation.scopes) ? validation.scopes : [],
    user_id: validation.user_id,
    login: validation.login,
    client_id: validation.client_id,
  };
}

export function saveTokenFile(file, token) {
  writeFileSync(file, `${JSON.stringify(token, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* best effort on platforms without chmod */
  }
  return file;
}

/** Refresh when the token is close to expiry, then persist it. */
export async function ensureFreshToken({ token, clientId, clientSecret, logger, fetchImpl, skewSeconds = 300 }) {
  if (!token?.refresh_token || !clientSecret) return token;
  const expiresAt = Date.parse(token.expires_at ?? '');
  if (Number.isFinite(expiresAt) && expiresAt - Date.now() > skewSeconds * 1000) return token;
  logger?.info?.('refreshing Twitch token');
  const refreshed = await refreshToken({
    clientId,
    clientSecret,
    refreshToken: token.refresh_token,
    fetchImpl,
  });
  const described = await describeToken(refreshed, { fetchImpl });
  const merged = { ...token, ...described };
  if (token.file) saveTokenFile(token.file, merged);
  return merged;
}
