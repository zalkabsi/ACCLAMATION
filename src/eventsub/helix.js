/**
 * The small slice of Helix the product needs: who is this token, what channel
 * id does this login have, and create/delete EventSub subscriptions bound to a
 * WebSocket session.
 */

const HELIX = 'https://api.twitch.tv/helix';
const VALIDATE = 'https://id.twitch.tv/oauth2/validate';

export class TwitchApiError extends Error {
  constructor(message, { status = null, body = null } = {}) {
    super(message);
    this.name = 'TwitchApiError';
    this.status = status;
    this.body = body;
  }
}

export class HelixClient {
  constructor({ clientId, token, fetchImpl = globalThis.fetch, apiBase = HELIX, validateUrl = VALIDATE }) {
    this.clientId = clientId;
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.apiBase = apiBase;
    this.validateUrl = validateUrl;
  }

  get headers() {
    return { 'client-id': this.clientId, authorization: `Bearer ${this.token}` };
  }

  /** Works with either a user token or an app token. */
  async validate() {
    const response = await this.fetchImpl(this.validateUrl, {
      headers: { authorization: `OAuth ${this.token}` },
    });
    if (response.status === 401) throw new TwitchApiError('access token is invalid or expired', { status: 401 });
    if (!response.ok) throw new TwitchApiError(`token validation failed (${response.status})`, { status: response.status });
    return response.json();
  }

  async getUser(login) {
    const response = await this.fetchImpl(`${this.apiBase}/users?login=${encodeURIComponent(login)}`, {
      headers: this.headers,
    });
    const body = await parseJson(response);
    if (!response.ok) throw new TwitchApiError(errorMessage(body, response.status), { status: response.status, body });
    const user = body?.data?.[0];
    if (!user) throw new TwitchApiError(`no Twitch user found for login "${login}"`, { status: 404, body });
    return user;
  }

  async listSubscriptions() {
    const response = await this.fetchImpl(`${this.apiBase}/eventsub/subscriptions`, { headers: this.headers });
    const body = await parseJson(response);
    if (!response.ok) throw new TwitchApiError(errorMessage(body, response.status), { status: response.status, body });
    return body?.data ?? [];
  }

  async createSubscription({ type, version = '1', condition, sessionId }) {
    const response = await this.fetchImpl(`${this.apiBase}/eventsub/subscriptions`, {
      method: 'POST',
      headers: { ...this.headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        type,
        version,
        condition,
        transport: { method: 'websocket', session_id: sessionId },
      }),
    });
    const body = await parseJson(response);
    if (response.status === 409) return { alreadyExists: true, data: body?.data?.[0] ?? null };
    if (!response.ok) {
      throw new TwitchApiError(errorMessage(body, response.status), { status: response.status, body });
    }
    return { alreadyExists: false, data: body?.data?.[0] ?? null };
  }

  async deleteSubscription(id) {
    const response = await this.fetchImpl(`${this.apiBase}/eventsub/subscriptions?id=${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: this.headers,
    });
    if (response.status === 404) return false;
    if (!response.ok) throw new TwitchApiError(`could not delete subscription (${response.status})`, { status: response.status });
    return true;
  }
}

/** Every subscription type Chorus reads, with its required condition/scopes. */
export function chatSubscriptions({ broadcasterUserId, userId, hasSubscriptionScope }) {
  const subscriptions = [
    {
      type: 'channel.chat.message',
      condition: { broadcaster_user_id: broadcasterUserId, user_id: userId },
      scope: 'user:read:chat',
    },
    {
      type: 'channel.chat.message_delete',
      condition: { broadcaster_user_id: broadcasterUserId, user_id: userId },
      scope: 'user:read:chat',
    },
    {
      type: 'channel.raid',
      condition: { to_broadcaster_user_id: broadcasterUserId },
      scope: null,
    },
  ];
  if (hasSubscriptionScope) {
    subscriptions.push({
      type: 'channel.subscribe',
      condition: { broadcaster_user_id: broadcasterUserId },
      scope: 'channel:read:subscriptions',
    });
  }
  return subscriptions;
}

export async function subscribeAll({ helix, sessionId, broadcasterUserId, userId, scopes = [], logger }) {
  const results = [];
  for (const subscription of chatSubscriptions({
    broadcasterUserId,
    userId,
    hasSubscriptionScope: scopes.includes('channel:read:subscriptions'),
  })) {
    if (subscription.scope && !scopes.includes(subscription.scope)) {
      results.push({ ...subscription, status: 'skipped', reason: `missing scope ${subscription.scope}` });
      continue;
    }
    try {
      const { alreadyExists, data } = await helix.createSubscription({
        type: subscription.type,
        condition: subscription.condition,
        sessionId,
      });
      results.push({ ...subscription, status: alreadyExists ? 'existing' : 'created', id: data?.id ?? null });
      logger?.info?.('eventsub subscription ready', { type: subscription.type, status: alreadyExists ? 'existing' : 'created' });
    } catch (error) {
      results.push({ ...subscription, status: 'failed', error: error.message });
      logger?.warn?.('eventsub subscription failed', { type: subscription.type, error: error.message });
    }
  }
  return results;
}

async function parseJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function errorMessage(body, status) {
  return body?.message ? `${body.message} (${status})` : `Twitch API request failed (${status})`;
}
