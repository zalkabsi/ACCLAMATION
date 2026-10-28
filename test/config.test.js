import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ConfigError, loadConfig, parseEnv, publicConfig } from '../src/config.js';

test('env parsing handles comments, quotes and export prefixes', () => {
  const parsed = parseEnv(`
    # a comment
    TWITCH_CLIENT_ID=abc123
    export LLM_MODEL="gpt-4o-mini"
    BLOCKED_TERMS='one,two'
    EMPTY=
    BAD KEY=nope
  `);
  assert.equal(parsed.TWITCH_CLIENT_ID, 'abc123');
  assert.equal(parsed.LLM_MODEL, 'gpt-4o-mini');
  assert.equal(parsed.BLOCKED_TERMS, 'one,two');
  assert.equal(parsed.EMPTY, '');
  assert.equal(parsed['BAD KEY'], undefined);
});

test('provider defaults to local without a key and openai with one', () => {
  const local = loadConfig({ env: {}, cwd: '/tmp/acclamation-config-test' });
  assert.equal(local.provider, 'local');
  assert.equal(local.liveEnabled, false);
  assert.equal(local.channel.windowSeconds, 120);

  const openai = loadConfig({ env: { LLM_API_KEY: 'sk-test' }, cwd: '/tmp/acclamation-config-test' });
  assert.equal(openai.provider, 'openai');

  const explicit = loadConfig({ env: { LLM_API_KEY: 'sk-test', ACCLAMATION_PROVIDER: 'local' }, cwd: '/tmp/acclamation-config-test' });
  assert.equal(explicit.provider, 'local');
});

test('embedding clustering is opt-in and requires the OpenAI key', () => {
  const lexical = loadConfig({
    env: { ACCLAMATION_EMBEDDINGS: 'openai' },
    cwd: '/tmp/acclamation-config-test',
  });
  assert.equal(lexical.embeddings.provider, 'none');
  assert.ok(lexical.warnings.some((warning) => warning.includes('using lexical clustering')));

  const openai = loadConfig({
    env: { ACCLAMATION_EMBEDDINGS: 'openai', LLM_API_KEY: 'sk-test' },
    cwd: '/tmp/acclamation-config-test',
  });
  assert.equal(openai.embeddings.provider, 'openai');
  assert.equal(openai.embeddings.model, 'text-embedding-3-small');
  assert.equal(publicConfig(openai).embeddings, 'openai');
  assert.equal(JSON.stringify(publicConfig(openai)).includes('sk-test'), false);
});

test('invalid numbers and providers fail loudly', () => {
  assert.throws(() => loadConfig({ env: { WINDOW_SECONDS: 'soon' }, cwd: '/tmp/x' }), ConfigError);
  assert.throws(() => loadConfig({ env: { WINDOW_SECONDS: '5' }, cwd: '/tmp/x' }), ConfigError);
  assert.throws(() => loadConfig({ env: { ACCLAMATION_PROVIDER: 'gpt' }, cwd: '/tmp/x' }), ConfigError);
});

test('a token file is read without exposing the token in public config', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'acclamation-'));
  const tokenFile = path.join(dir, '.tokens.json');
  writeFileSync(
    tokenFile,
    JSON.stringify({
      access_token: 'secret-token',
      refresh_token: 'refresh',
      user_id: '123',
      login: 'zalkabsi',
      scopes: ['user:read:chat'],
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    }),
  );
  const config = loadConfig({
    env: { TWITCH_CLIENT_ID: 'client', TWITCH_CHANNEL: 'zalkabsi' },
    cwd: dir,
    tokenFile,
  });
  assert.equal(config.liveEnabled, true);
  assert.equal(config.twitch.userId, '123');
  assert.deepEqual(config.twitch.scopes, ['user:read:chat']);

  const published = publicConfig(config);
  assert.equal(JSON.stringify(published).includes('secret-token'), false);
  assert.equal(JSON.stringify(published).includes('refresh'), false);
  assert.equal(published.liveEnabled, true);
  assert.deepEqual(published.missingScopes, []);
});
