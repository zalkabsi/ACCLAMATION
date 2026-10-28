import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Scopes Chorus needs.
 * `user:read:chat` is required for channel.chat.message and
 * channel.chat.message_delete. `channel:read:subscriptions` unlocks
 * channel.subscribe hype moments and `channel:moderate` unlocks channel ban
 * and unban notifications; both are optional.
 * channel.raid requires no authorization.
 */
export const REQUIRED_SCOPES = ['user:read:chat'];
export const OPTIONAL_SCOPES = ['channel:read:subscriptions', 'channel:moderate'];
export const ALL_SCOPES = [...REQUIRED_SCOPES, ...OPTIONAL_SCOPES];

export const DEFAULT_BOTS = [
  'nightbot',
  'streamelements',
  'streamlabs',
  'sery_bot',
  'fossabot',
  'moobot',
  'wizebot',
  'commanderroot',
  'soundalerts',
  'pretzelrocks',
  'botisimo',
  'marbiebot',
  'kofistreambot',
  'himeko',
  'recastly',
  'squadbot',
];

export const DEFAULT_QUESTION = 'Chat, what do you actually think?';

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Minimal .env parser: KEY=VALUE, `export` prefixes, # comments, single or
 * double quotes. No variable expansion — keeps configuration predictable.
 */
export function parseEnv(text) {
  const out = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const withoutExport = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = withoutExport.indexOf('=');
    if (eq <= 0) continue;
    const key = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = withoutExport.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value.replace(/\\n/g, '\n');
  }
  return out;
}

/** Read .env.local then .env from `cwd`, without clobbering real env vars. */
export function loadDotenv(cwd = process.cwd(), env = process.env) {
  for (const name of ['.env.local', '.env']) {
    const file = path.join(cwd, name);
    if (!existsSync(file)) continue;
    const parsed = parseEnv(readFileSync(file, 'utf8'));
    for (const [key, value] of Object.entries(parsed)) {
      if (env[key] === undefined || env[key] === '') env[key] = value;
    }
  }
  return env;
}

export function loadTokenFile(file) {
  if (!file || !existsSync(file)) return null;
  try {
    const token = JSON.parse(readFileSync(file, 'utf8'));
    if (!token?.access_token) return null;
    return token;
  } catch {
    return null;
  }
}

function num(env, key, fallback, { min = -Infinity, max = Infinity } = {}) {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new ConfigError(`${key} must be a number, got ${JSON.stringify(raw)}`);
  if (value < min || value > max) throw new ConfigError(`${key} must be between ${min} and ${max}, got ${value}`);
  return value;
}

function bool(env, key, fallback) {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

function list(env, key) {
  const raw = env[key];
  if (!raw) return [];
  return raw
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function loadConfig({ env = process.env, cwd = process.cwd(), tokenFile } = {}) {
  const tokensPath = tokenFile ?? path.join(cwd, '.tokens.json');
  const stored = loadTokenFile(tokensPath);
  const warnings = [];

  const llmApiKey = env.LLM_API_KEY || '';
  const requestedProvider = (env.ACCLAMATION_PROVIDER || 'auto').toLowerCase();
  if (!['auto', 'openai', 'local'].includes(requestedProvider)) {
    throw new ConfigError(`ACCLAMATION_PROVIDER must be auto, openai or local (got ${requestedProvider})`);
  }
  const provider = requestedProvider === 'auto' ? (llmApiKey ? 'openai' : 'local') : requestedProvider;
  if (provider === 'openai' && !llmApiKey) {
    warnings.push('provider=openai but LLM_API_KEY is empty — falling back to the local voice');
  }

  const twitch = {
    clientId: env.TWITCH_CLIENT_ID || '',
    clientSecret: env.TWITCH_CLIENT_SECRET || '',
    channel: (env.TWITCH_CHANNEL || '').toLowerCase(),
    userId: env.TWITCH_USER_ID || stored?.user_id || '',
    redirectUri: env.TWITCH_REDIRECT_URI || 'http://localhost:8917/callback',
    token: env.TWITCH_USER_TOKEN || stored?.access_token || '',
    refreshToken: stored?.refresh_token || '',
    tokenExpiresAt: stored?.expires_at || null,
    scopes: Array.isArray(stored?.scopes) ? stored.scopes : [],
    tokenFile: tokensPath,
  };

  const resolvedProvider = provider === 'openai' && !llmApiKey ? 'local' : provider;

  const requestedEmbeddings = (env.ACCLAMATION_EMBEDDINGS || 'none').toLowerCase();
  if (!['none', 'openai'].includes(requestedEmbeddings)) {
    throw new ConfigError(
      `ACCLAMATION_EMBEDDINGS must be none or openai (got ${requestedEmbeddings})`,
    );
  }
  const embeddingProvider = requestedEmbeddings === 'openai' && llmApiKey ? 'openai' : 'none';
  if (requestedEmbeddings === 'openai' && !llmApiKey) {
    warnings.push('ACCLAMATION_EMBEDDINGS=openai but LLM_API_KEY is empty — using lexical clustering');
  }

  return {
    cwd,
    provider: resolvedProvider,
    warnings,
    twitch,
    liveEnabled: Boolean(twitch.clientId && twitch.token && twitch.channel),
    channel: {
      windowSeconds: num(env, 'WINDOW_SECONDS', 120, { min: 15, max: 600 }),
      maxMessages: num(env, 'MAX_MESSAGES', 4000, { min: 50, max: 20000 }),
      minChatters: num(env, 'MIN_CHATTERS', 4, { min: 1, max: 100 }),
      perUserCap: num(env, 'PER_USER_CAP', 6, { min: 1, max: 50 }),
    },
    safety: {
      blockedTerms: list(env, 'BLOCKED_TERMS'),
      blockedUsers: list(env, 'BLOCKED_USERS').map((u) => u.toLowerCase()),
      bots: [...new Set([...DEFAULT_BOTS, ...list(env, 'BOT_USERS').map((u) => u.toLowerCase())])],
      allowLinks: bool(env, 'ALLOW_LINKS', false),
    },
    llm: {
      baseUrl: (env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
      apiKey: llmApiKey,
      model: env.LLM_MODEL || 'gpt-4o-mini',
      timeoutMs: num(env, 'LLM_TIMEOUT_MS', 6000, { min: 500, max: 60000 }),
      temperature: num(env, 'LLM_TEMPERATURE', 0.6, { min: 0, max: 2 }),
    },
    embeddings: {
      provider: embeddingProvider,
      baseUrl: (env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
      apiKey: llmApiKey,
      model: env.EMBEDDINGS_MODEL || 'text-embedding-3-small',
      timeoutMs: num(env, 'EMBEDDINGS_TIMEOUT_MS', 3500, { min: 300, max: 15000 }),
    },
    tts: {
      provider: (env.TTS_PROVIDER || 'client').toLowerCase(),
      voice: env.TTS_VOICE || 'onyx',
      model: env.TTS_MODEL || 'gpt-4o-mini-tts',
    },
    server: {
      port: num(env, 'PORT', 8787, { min: 1, max: 65535 }),
      host: env.HOST || '127.0.0.1',
    },
    memoryPath: env.MEMORY_PATH || path.join(cwd, '.data', 'acclamation.sqlite'),
    defaultQuestion: env.DEFAULT_QUESTION || DEFAULT_QUESTION,
  };
}

/** Mask secrets before anything reaches a browser or a log line. */
export function publicConfig(config) {
  return {
    provider: config.provider,
    liveEnabled: config.liveEnabled,
    channel: config.twitch.channel || null,
    userId: config.twitch.userId || null,
    scopes: config.twitch.scopes,
    missingScopes: REQUIRED_SCOPES.filter((s) => !config.twitch.scopes.includes(s)),
    missingOptionalScopes: OPTIONAL_SCOPES.filter((s) => !config.twitch.scopes.includes(s)),
    windowSeconds: config.channel.windowSeconds,
    minChatters: config.channel.minChatters,
    allowLinks: config.safety.allowLinks,
    blockedTerms: config.safety.blockedTerms,
    tts: config.tts.provider,
    embeddings: config.embeddings?.provider || 'none',
    model: config.provider === 'local' ? 'local' : config.llm.model,
    warnings: config.warnings,
  };
}
