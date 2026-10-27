import { ChannelSession } from '../core/session.js';
import { ChatWindow } from '../chat/window.js';
import { Scrubber } from '../chat/scrub.js';
import { loadConfig, loadDotenv, loadTokenFile } from '../config.js';
import { openMemory } from '../memory/store.js';
import { EventSubClient } from '../eventsub/client.js';
import { HelixClient, subscribeAll } from '../eventsub/helix.js';
import { ensureFreshToken } from '../auth/flow.js';
import { createLogger } from '../log.js';
import { createApp } from './http.js';

/**
 * Long-running entry point: one channel, dashboard on /, overlay on /overlay.
 * In live mode it keeps its EventSub session subscribed across reconnects; in
 * sample mode it still serves the UI and says clearly that chat is not wired.
 */
export async function startApp({ config, logger: providedLogger } = {}) {
  const logger = providedLogger ?? createLogger({ level: process.env.LOG_LEVEL || 'info' });
  const memory = await openMemory({ file: config.memoryPath, channel: config.twitch.channel || 'local', logger });
  const scrubber = new Scrubber(config.safety);
  const chatWindow = new ChatWindow({
    seconds: config.channel.windowSeconds,
    maxMessages: config.channel.maxMessages,
    perUserCap: config.channel.perUserCap,
    scrubber,
  });
  const session = new ChannelSession({ config, memory, window: chatWindow, logger });

  const connection = {
    status: 'sample',
    sessionId: null,
    keepalive: null,
    subscribed: [],
    error: null,
  };

  const app = createApp({
    config,
    session,
    memory,
    logger,
    connection: () => ({ ...connection }),
  });

  await new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(config.server.port, config.server.host, resolve);
  });
  const url = `http://${config.server.host}:${config.server.port}`;
  logger.info('listening', { dashboard: url, overlay: `${url}/overlay`, provider: config.provider });

  let eventSub = null;
  let twitch = null;

  if (config.liveEnabled) {
    // Refresh the stored token before opening the socket.
    let token = config.twitch.token;
    const stored = loadTokenFile(config.twitch.tokenFile);
    if (stored && config.twitch.clientSecret && !process.env.TWITCH_USER_TOKEN) {
      try {
        const fresh = await ensureFreshToken({
          token: stored,
          clientId: config.twitch.clientId,
          clientSecret: config.twitch.clientSecret,
          logger,
        });
        token = fresh.access_token;
      } catch (error) {
        logger.warn('token refresh failed; using stored token', { error: error.message });
      }
    }
    twitch = new HelixClient({ clientId: config.twitch.clientId, token });
    eventSub = new EventSubClient({ logger });
    connection.status = 'connecting';

    let lastSessionId = null;
    eventSub.on('welcome', async (welcome) => {
      connection.status = 'connected';
      connection.sessionId = welcome.sessionId;
      connection.keepalive = welcome.keepaliveTimeoutSeconds;
      if (lastSessionId === welcome.sessionId) return;
      lastSessionId = welcome.sessionId;
      try {
        const validation = await twitch.validate();
        const results = await subscribeAll({
          helix: twitch,
          sessionId: welcome.sessionId,
          broadcasterUserId: config.twitch.userId || validation.user_id,
          userId: validation.user_id,
          scopes: validation.scopes,
          logger,
        });
        connection.subscribed = results;
        const failures = results.filter((r) => r.status === 'failed');
        if (failures.length) {
          logger.warn('some subscriptions failed', { failed: failures.map((f) => f.type) });
        }
        logger.info('eventsub subscriptions ready', {
          types: results.filter((r) => ['created', 'existing'].includes(r.status)).map((r) => r.type),
        });
      } catch (error) {
        connection.error = error.message;
        logger.error('could not subscribe', { error: error.message });
      }
    });
    eventSub.on('keepalive', () => {
      connection.lastKeepaliveAt = Date.now();
    });
    eventSub.on('close', () => {
      if (connection.status !== 'stopped') connection.status = 'reconnecting';
    });
    eventSub.on('socket-error', ({ error }) => {
      connection.error = error?.message || String(error);
    });
    eventSub.on('notification', (notification) => {
      session.ingest(notification.type, notification.event, notification.metadata);
    });
    eventSub.start();
  } else {
    logger.warn('sample mode: no Twitch credentials, chat feed is empty', {
      fix: 'npm run auth && npm run doctor',
      replay: 'npm run replay -- --serve',
    });
  }

  const close = async () => {
    eventSub?.stop();
    await new Promise((resolve) => app.server.close(resolve));
    memory.close?.();
  };

  return { server: app.server, url, session, memory, close, eventSub };
}

async function main() {
  loadDotenv();
  const config = loadConfig({ cwd: process.cwd() });
  const logger = createLogger({ level: process.env.LOG_LEVEL || 'info' });
  const app = await startApp({ config, logger });

  console.log('');
  console.log('  ACCLAMATION — chat, with one voice.');
  console.log('');
  console.log(`  Dashboard  ${app.url}`);
  console.log(`  Overlay    ${app.url}/overlay   (OBS browser source: 1920x1080, transparent)`);
  console.log(`  Voice      ${config.provider === 'local' ? 'local (no model key; deterministic receipts)' : config.llm.model}`);
  console.log(`  Twitch     ${config.liveEnabled ? `live on #${config.twitch.channel}` : 'sample mode — npm run auth, then npm run doctor'}`);
  console.log('');
  console.log('  Press Ctrl+C to stop.');
  console.log('');

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
      console.log('\n  stopping…');
      await app.close();
      process.exit(0);
    });
  }
}

main().catch((error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${process.env.PORT || 8787} is already in use. Stop the other server or set PORT.`);
  } else {
    console.error(error);
  }
  process.exit(1);
});
