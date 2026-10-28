#!/usr/bin/env node
/**
 * Offline replay harness.
 *
 * Plays a JSONL transcript through a fake EventSub WebSocket into the real
 * client, window, scrubber, clusterer and answer pipeline. Same code path as
 * production; no Twitch account, no network, no API key required.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig, loadDotenv } from '../src/config.js';
import { ChatWindow } from '../src/chat/window.js';
import { Scrubber } from '../src/chat/scrub.js';
import { ChannelSession } from '../src/core/session.js';
import { openMemory } from '../src/memory/store.js';
import { EventSubClient } from '../src/eventsub/client.js';
import { FakeEventSubServer } from './fake-eventsub.js';
import { createLogger } from '../src/log.js';
import { createOpenAIEmbedder } from '../src/llm/embeddings.js';
import { createApp } from '../src/server/http.js';

export function parseArgs(argv = process.argv.slice(2)) {
  const args = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const [key, inline] = token.slice(2).split('=');
    if (inline !== undefined) {
      args.set(key, inline);
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      args.set(key, next);
      i += 1;
    } else {
      args.set(key, true);
    }
  }
  return args;
}

export async function loadFixture(file) {
  const text = await readFile(file, 'utf8');
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('//') && !line.startsWith('#'))
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`${path.basename(file)}:${index + 1} is not valid JSON: ${error.message}`);
      }
    })
    .sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
}

function eventFor(item, offset) {
  const at = offset + (item.t ?? 0);
  switch (item.type || 'chat') {
    case 'delete':
      return { at, subscriptionType: 'channel.chat.message_delete', event: { message_id: item.id, target_user_login: item.user } };
    case 'raid':
      return {
        at,
        subscriptionType: 'channel.raid',
        event: { from_broadcaster_user_login: item.user, from_broadcaster_user_name: item.user, viewers: item.viewers ?? 0 },
      };
    case 'subscribe':
      return {
        at,
        subscriptionType: 'channel.subscribe',
        event: { user_login: item.user, user_name: item.user, tier: item.tier ?? '1000', is_gift: false },
      };
    case 'chat':
    default:
      return {
        at,
        subscriptionType: 'channel.chat.message',
        event: {
          message_id: item.id || `${item.user}-${item.t ?? 0}`,
          chatter_user_login: item.user,
          chatter_user_name: item.display || item.user,
          chatter_user_id: `id-${item.user}`,
          message: { text: item.text ?? '' },
          message_type: item.messageType || 'text',
          badges: (item.badges || []).map((setId) => ({ set_id: setId, id: '1' })),
          color: '#9ad1ff',
        },
      };
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runReplay({
  fixture,
  speed = 20,
  question,
  serve = false,
  ask = true,
  provider,
  logger = createLogger({ level: 'warn' }),
} = {}) {
  loadDotenv();
  const config = loadConfig({ cwd: process.cwd() });
  if (provider) {
    if (provider === 'openai' && !config.llm.apiKey) throw new Error('--provider=openai needs LLM_API_KEY');
    config.provider = provider;
  }
  config.memoryPath = ':memory:';

  const memory = await openMemory({ file: ':memory:' });
  const session = new ChannelSession({
    config,
    memory,
    window: new ChatWindow({
      seconds: config.channel.windowSeconds,
      maxMessages: config.channel.maxMessages,
      perUserCap: config.channel.perUserCap,
      scrubber: new Scrubber(config.safety),
    }),
    logger,
    embed: config.embeddings?.provider === 'openai'
      ? createOpenAIEmbedder(config.embeddings)
      : undefined,
  });

  const server = await new FakeEventSubServer({ keepaliveTimeoutSeconds: 10, logger }).listen();
  const client = new EventSubClient({ url: server.url, minReconnectDelayMs: 100, logger });
  const events = [];

  client.on('notification', (notification) => {
    events.push(notification);
    session.ingest(notification.type, notification.event, notification.metadata);
  });
  client.start();
  await server.waitForSession(4000);

  const items = await loadFixture(fixture);
  const offset = Date.now();
  let previous = 0;
  for (const item of items) {
    const when = (item.t ?? 0) / speed;
    const wait = when - previous;
    if (wait > 0) await sleep(wait);
    previous = when;
    const { subscriptionType, event, at } = eventFor(item, offset);
    server.sendEvent(null, subscriptionType, event, {
      messageId: `replay-${item.type || 'chat'}-${item.id || item.t}-${events.length}`,
    });
    if (item.type === 'delete') {
      // deletion is delivered after the message it targets, same as Twitch
      events.push({ type: subscriptionType, event, metadata: { message_timestamp: new Date(at).toISOString() } });
    }
  }
  await sleep(120);

  const statsBefore = session.window.stats();
  let answer = null;
  if (ask) {
    answer = await session.ask({ question });
    printAnswer(answer, speed);
  }

  printTrust(statsBefore, session);

  if (!serve) {
    client.stop();
    await server.close();
    memory.close?.();
    return { answer, stats: statsBefore, session };
  }

  const app = createApp({
    config,
    session,
    memory,
    logger,
    connection: () => ({ status: 'replay', sessionId: client.sessionId, keepalive: 10, replay: true }),
  });
  await new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(config.server.port, config.server.host, resolve);
  });
  console.log('');
  console.log(`  replay dashboard  http://${config.server.host}:${config.server.port}`);
  console.log(`  replay overlay    http://${config.server.host}:${config.server.port}/overlay`);
  console.log('');
  console.log('  Serving this replay. Press Ctrl+C to stop.');
  const shutdown = async () => {
    client.stop();
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return { answer, stats: statsBefore, session, server, client };
}

function printAnswer(answer, speed) {
  const pct = answer.confidence == null ? 'no number' : `${answer.confidence}% confidence`;
  console.log('');
  console.log(`  ── ${answer.mode.toUpperCase()} · ${pct} · ${answer.provider} · ${answer.timings.totalMs}ms (${answer.timings.modelMs}ms model) ──`);
  console.log('');
  if (answer.mode === 'dissent' && answer.voices) {
    answer.voices.forEach((voice, index) => {
      console.log(`  ${index === 0 ? 'A' : 'B'} (${voice.label}): ${voice.stance}`);
      for (const receipt of voice.receipts) {
        console.log(`      @${receipt.user}: ${receipt.text}`);
      }
    });
  } else {
    console.log(`  ${answer.stance}`);
    for (const receipt of answer.receipts) {
      console.log(`      @${receipt.user}: ${receipt.text}`);
    }
  }
  if (answer.note) console.log(`  note: ${answer.note}`);
  console.log('');
  console.log(
    `  measured: ${answer.chatters} chatters · ${answer.basis.messages} messages · top share ${Math.round(
      (answer.share ?? 0) * 100,
    )}%${answer.split ? ` · split ${answer.split.a}/${answer.split.b}` : ''}`,
  );
}

function printTrust(stats, session) {
  const reasons = Object.entries(stats.filteredByReason || {});
  const blocked = stats.blocked ?? Math.max(0, stats.received - stats.accepted);
  const removed = (stats.filteredByReason?.deleted ?? 0) + (stats.filteredByReason?.banned_user ?? 0);
  const detail = reasons.length ? ` (${reasons.map(([reason, count]) => `${reason}: ${count}`).join(', ')})` : '';
  console.log(`  safety: ${stats.accepted} accepted · ${blocked} blocked at intake · ${removed} removed after accepting${detail}`);
  console.log('');
}

async function main() {
  const args = parseArgs();
  const fixture = args.get('fixture') || 'replay/fixtures/consensus.jsonl';
  const speed = Number(args.get('speed') || 20);
  const provider = args.get('provider');
  await runReplay({
    fixture,
    speed,
    question: typeof args.get('question') === 'string' ? args.get('question') : undefined,
    serve: Boolean(args.get('serve')),
    ask: !args.get('no-ask'),
    provider: typeof provider === 'string' ? provider : undefined,
    logger: createLogger({ level: args.get('verbose') ? 'debug' : 'warn' }),
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`Port ${process.env.PORT || 8787} is already in use. Stop the other server or set PORT.`);
    } else {
      console.error(error.message);
    }
    process.exit(1);
  });
}
