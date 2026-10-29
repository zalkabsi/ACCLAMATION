import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { publicConfig } from '../config.js';
import { BusyError } from '../core/session.js';

const STATIC = {
  '/': ['web', 'index.html'],
  '/index.html': ['web', 'index.html'],
  '/app.js': ['web', 'app.js'],
  '/style.css': ['web', 'style.css'],
  '/overlay': ['overlay', 'index.html'],
  '/overlay/': ['overlay', 'index.html'],
  '/overlay/face.js': ['overlay', 'face.js'],
  '/overlay/style.css': ['overlay', 'style.css'],
  '/overlay/app.js': ['overlay', 'face.js'],
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

/**
 * Dashboard + overlay + JSON API + SSE. No framework: one process, four
 * routes that matter, and a static map with no path traversal surface.
 */
export function createApp({ config, session, memory, logger, connection = () => ({}), root = process.cwd() }) {
  const clients = new Set();
  let lastChatSentAt = 0;

  const send = (res, event, data) => {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      clients.delete(res);
    }
  };
  const broadcast = (event, data) => {
    for (const res of clients) send(res, event, data);
  };

  session.on('chat', (message) => {
    const now = Date.now();
    // The overlay needs a pulse per message, not a firehose.
    if (now - lastChatSentAt < 70) return;
    lastChatSentAt = now;
    broadcast('chat', message);
  });
  for (const event of ['answer', 'trigger:start', 'hype', 'score', 'delete', 'provider:error']) {
    session.on(event, (payload) => broadcast(event, payload));
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    try {
      if (req.method === 'GET' && STATIC[url.pathname]) {
        return serveStatic(res, root, STATIC[url.pathname], logger);
      }
      if (req.method === 'GET' && url.pathname === '/favicon.ico') {
        res.writeHead(204).end();
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/state') {
        return json(res, 200, {
          ok: true,
          config: publicConfig(config),
          connection: connection(),
          session: session.state(),
          tts: { provider: config.tts.provider, voice: config.tts.voice },
        });
      }
      if (req.method === 'GET' && url.pathname === '/api/events') {
        return stream(res, { session, connection, config, clients });
      }
      if (req.method === 'GET' && url.pathname === '/api/health') {
        return json(res, 200, {
          ok: true,
          provider: config.provider,
          live: config.liveEnabled,
          connection: connection(),
        });
      }
      if (req.method === 'POST' && url.pathname === '/api/trigger') {
        const body = await readJson(req);
        try {
          const answer = await session.ask({ question: body.question, forceMode: body.mode });
          return json(res, 200, { ok: true, answer });
        } catch (error) {
          if (error instanceof BusyError) return json(res, 409, { ok: false, error: error.message });
          logger?.error('trigger failed', { error: error.message });
          return json(res, 500, { ok: false, error: 'could not generate an answer' });
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/score') {
        const body = await readJson(req);
        const board = session.markScore(body.winner);
        return json(res, 200, { ok: true, scoreboard: board });
      }
      if (req.method === 'GET' && url.pathname === '/api/lore') {
        return json(res, 200, { ok: true, lore: memory.listLore(20) });
      }
      if (req.method === 'POST' && url.pathname === '/api/lore') {
        const body = await readJson(req);
        const text = String(body.text || '').trim();
        if (!text) return json(res, 400, { ok: false, error: 'text is required' });
        return json(res, 200, { ok: true, lore: memory.addLore(text.slice(0, 280)) });
      }
      if (req.method === 'DELETE' && url.pathname.startsWith('/api/lore/')) {
        const id = Number(url.pathname.split('/').pop());
        return json(res, 200, { ok: memory.deleteLore(id) });
      }
      if (req.method === 'GET' && url.pathname === '/api/tts') {
        return synthesize(res, url, config, logger);
      }
      return json(res, 404, { ok: false, error: 'not found' });
    } catch (error) {
      logger?.error('request failed', { path: url.pathname, error: error.message });
      if (!res.headersSent) json(res, 500, { ok: false, error: 'internal error' });
      else res.end();
    }
  });

  const heartbeat = setInterval(() => {
    for (const res of clients) {
      try {
        res.write(': keepalive\n\n');
      } catch {
        clients.delete(res);
      }
    }
  }, 15000);
  heartbeat.unref?.();

  const closeStreams = () => {
    for (const res of clients) {
      try {
        res.end();
      } catch {
        /* noop */
      }
    }
    clients.clear();
  };

  server.on('close', () => {
    clearInterval(heartbeat);
    closeStreams();
  });

  return { server, broadcast, clients, closeStreams };
}

function stream(res, { session, connection, config, clients }) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  });
  res.write('retry: 1500\n\n');
  res.write(`event: hello\ndata: ${JSON.stringify({ config: publicConfig(config), state: session.state(), connection: connection() })}\n\n`);
  clients.add(res);
  res.on('close', () => clients.delete(res));
}

async function serveStatic(res, root, [dir, file], logger) {
  const target = path.resolve(root, dir, file);
  if (!target.startsWith(path.resolve(root, dir))) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const data = await readFile(target);
    res.writeHead(200, {
      'content-type': MIME[path.extname(target)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(data);
  } catch (error) {
    logger?.warn?.('static file missing', { file: `${dir}/${file}` });
    res.writeHead(404).end('not found');
  }
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 256 * 1024) throw new Error('request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

async function synthesize(res, url, config, logger) {
  const text = String(url.searchParams.get('text') || '').slice(0, 400).trim();
  if (!text) return json(res, 400, { ok: false, error: 'text is required' });
  if (config.tts.provider !== 'openai') {
    return json(res, 501, { ok: false, error: 'server-side TTS is not configured' });
  }
  if (!config.llm.apiKey) return json(res, 501, { ok: false, error: 'no API key for TTS' });

  try {
    const response = await fetch(`${config.llm.baseUrl}/audio/speech`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.llm.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: config.tts.model,
        voice: config.tts.voice,
        input: text,
        response_format: 'mp3',
      }),
      signal: AbortSignal.timeout(config.llm.timeoutMs),
    });
    if (!response.ok) {
      logger?.warn('tts request failed', { status: response.status });
      return json(res, 502, { ok: false, error: `TTS failed (${response.status})` });
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    res.writeHead(200, { 'content-type': 'audio/mpeg', 'cache-control': 'no-store', 'content-length': buffer.length });
    res.end(buffer);
  } catch (error) {
    logger?.warn('tts error', { error: error.message });
    if (!res.headersSent) json(res, 502, { ok: false, error: 'TTS unavailable' });
  }
}
