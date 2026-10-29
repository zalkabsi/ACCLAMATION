#!/usr/bin/env node
/**
 * The day-one go/no-go. Validates the token and scopes, opens a real EventSub
 * WebSocket, creates the subscriptions, and waits for an actual chat message.
 * Nothing here touches sample data.
 */
import { pathToFileURL } from 'node:url';
import { EventSubClient } from '../src/eventsub/client.js';
import { HelixClient, subscribeAll } from '../src/eventsub/helix.js';
import { OPTIONAL_SCOPES, REQUIRED_SCOPES, loadConfig, loadDotenv, loadTokenFile } from '../src/config.js';
import { ensureFreshToken, saveTokenFile } from '../src/auth/flow.js';
import { createLogger } from '../src/log.js';

const argv = new Map(
  process.argv
    .slice(2)
    .map((arg) => arg.replace(/^--/, '').split('='))
    .map(([key, value]) => [key, value ?? true]),
);

const line = (text) => console.log(`\n  ${text}`);

export async function runDoctor({ waitSeconds = Number(argv.get('wait') || 45) } = {}) {
  loadDotenv();
  const config = loadConfig({ cwd: process.cwd() });
  const logger = createLogger({ level: process.env.LOG_LEVEL || 'warn' });

  console.log('\n  Acclamation doctor');

  const problems = [];
  if (!config.twitch.clientId) problems.push('TWITCH_CLIENT_ID is missing (see .env.example)');
  const stored = loadTokenFile(config.twitch.tokenFile);
  if (!stored && !config.twitch.token) problems.push('No token file yet. Run `npm run auth` first');
  if (problems.length) {
    console.log('');
    for (const problem of problems) console.log(`  x ${problem}`);
    console.log('');
    return 2;
  }

  let token = stored ?? {
    access_token: config.twitch.token,
    refresh_token: null,
    expires_at: null,
    scopes: [],
    file: config.twitch.tokenFile,
  };

  try {
    const refreshed = await ensureFreshToken({
      token,
      clientId: config.twitch.clientId,
      clientSecret: config.twitch.clientSecret,
      logger,
    });
    if (refreshed.access_token !== token.access_token) saveTokenFile(config.twitch.tokenFile, refreshed);
    token = refreshed;
  } catch (error) {
    line(`x Could not refresh the token: ${error.message}`);
    line('Run `npm run auth` again.');
    return 1;
  }

  const helix = new HelixClient({ clientId: config.twitch.clientId, token: token.access_token });
  let validation;
  try {
    validation = await helix.validate();
  } catch (error) {
    line(`x Token rejected: ${error.message}`);
    line('Run `npm run auth` again.');
    return 1;
  }
  line(`+ Token valid for @${validation.login} (client ${validation.client_id})`);
  line(`  Scopes: ${validation.scopes.join(', ') || 'none'}`);

  const missing = REQUIRED_SCOPES.filter((scope) => !validation.scopes.includes(scope));
  if (missing.length) {
    line(`x Missing required scopes: ${missing.join(', ')}`);
    line('Run `npm run auth` and approve chat read access.');
    return 1;
  }
  line('+ Required scope present: user:read:chat');
  const optionalMissing = OPTIONAL_SCOPES.filter((scope) => !validation.scopes.includes(scope));
  if (optionalMissing.length) {
    line(`  Optional scopes missing; related subscriptions will be skipped: ${optionalMissing.join(', ')}`);
  }

  const channel = (config.twitch.channel || validation.login).toLowerCase();
  if (!config.twitch.channel) {
    line(`  TWITCH_CHANNEL is not set; using the token owner (@${validation.login}).`);
  }
  if (channel !== validation.login.toLowerCase()) {
    line(
      `x Token belongs to @${validation.login} but TWITCH_CHANNEL is @${channel}. ` +
        'Reading another channel needs user:bot + channel:bot and moderator status; ' +
        'for the hackathon demo, authorize the channel you stream on.',
    );
    return 1;
  }

  let broadcaster;
  try {
    broadcaster = await helix.getUser(channel);
  } catch (error) {
    line(`x Could not resolve channel @${channel}: ${error.message}`);
    return 1;
  }
  line(`+ Channel resolved: @${broadcaster.login} (id ${broadcaster.id})`);

  const client = new EventSubClient({ logger, minReconnectDelayMs: 500 });
  return waitForLiveChat({
    client,
    helix,
    broadcasterUserId: broadcaster.id,
    userId: validation.user_id,
    scopes: validation.scopes,
    channel,
    logger,
    waitSeconds,
  });
}

/** Wait for chat while keeping subscriptions attached to the current session. */
export async function waitForLiveChat({
  client, helix, broadcasterUserId, userId, scopes, channel, logger, waitSeconds,
  output = console.log,
}) {
  const logLine = (text) => output(`\n  ${text}`);
  logLine(`  Connecting to EventSub and waiting up to ${waitSeconds}s for one real message.`);

  return new Promise((resolve) => {
    let timer = null;
    let settled = false;
    let lastSessionId = null;
    const subscriptions = [];
    const pending = new Set();

    const finish = async (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.stop();
      // A notification or timeout can arrive while Helix is still creating
      // subscriptions. Wait for those results so every created id is cleaned up.
      await Promise.allSettled([...pending]);
      for (const subscription of subscriptions) {
        if (subscription.id && subscription.status === 'created') {
          try {
            await helix.deleteSubscription(subscription.id);
          } catch {
            /* best effort */
          }
        }
      }
      resolve(code);
    };

    client.on('welcome', (welcome) => {
      if (settled || lastSessionId === welcome.sessionId) return;
      lastSessionId = welcome.sessionId;
      logLine(`+ WebSocket connected (session ${welcome.sessionId}, keepalive ${welcome.keepaliveTimeoutSeconds}s)`);
      const task = (async () => {
        try {
          const created = await subscribeAll({
            helix,
            sessionId: welcome.sessionId,
            broadcasterUserId,
            userId,
            scopes,
            logger,
          });
          subscriptions.push(...created);
          // A plain reconnect may have replaced this session while its Helix
          // requests were in flight. Keep its ids for cleanup but ignore its result.
          if (settled || lastSessionId !== welcome.sessionId) return;
          for (const subscription of created) {
            const mark = ['created', 'existing'].includes(subscription.status) ? '+' : 'x';
            const detail = subscription.error
              ? ` (${subscription.error})`
              : subscription.reason
                ? ` (${subscription.reason})`
                : '';
            logLine(`${mark} ${subscription.type}: ${subscription.status}${detail}`);
          }
          const chatReady = created.some(
            (subscription) => subscription.type === 'channel.chat.message'
              && ['created', 'existing'].includes(subscription.status),
          );
          if (!chatReady) {
            logLine('x Could not subscribe to channel.chat.message; see the error above.');
            void finish(1);
          } else {
            logLine(`  Waiting for chat in #${channel}. Say something in chat.`);
          }
        } catch (error) {
          if (!settled && lastSessionId === welcome.sessionId) {
            logLine(`x Subscription setup failed: ${error.message}`);
            void finish(1);
          }
        }
      })();
      pending.add(task);
      void task.finally(() => pending.delete(task));
    });

    client.on('notification', (notification) => {
      if (notification.type !== 'channel.chat.message') return;
      const event = notification.event;
      output('');
      output('  + REAL CHAT ARRIVED');
      output(`    ${event.chatter_user_name}: ${event.message?.text ?? ''}`);
      output(`    message id: ${event.message_id}`);
      output('');
      output('  The live leg works. Next:');
      output('    npm start');
      output('');
      void finish(0);
    });

    client.on('revocation', (revocation) => {
      logLine(`x Subscription revoked: ${revocation.subscription?.type} (${revocation.status})`);
    });

    client.on('socket-error', ({ error }) => {
      logLine(`  socket error: ${error?.message || error}`);
    });

    timer = setTimeout(() => {
      output('');
      output(`  x No chat message arrived in ${waitSeconds}s.`);
      output('    Check the socket and subscription status, and ensure someone is chatting');
      output(`    in #${channel}. You can also use the replay harness: npm run replay`);
      output('');
      void finish(1);
    }, waitSeconds * 1000);

    client.start();
  });
}

function main() {
  runDoctor().then((code) => {
    if (typeof code === 'number') process.exit(code);
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
