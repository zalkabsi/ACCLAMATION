# Acclamation — agent notes

> **Your chat has a word. Now it has a voice.**

Acclamation turns a Twitch chat into a single character the streamer can talk
to. It reads a rolling window of real chat, measures what the room actually
thinks, and answers in one voice — quoting real chatters as receipts, splitting
into two arguing voices when chat is divided, and keeping a Streamer-vs-Chat
scoreboard. The overlay is the product: a swarm of glyphs (one per message)
collapses into a face when it speaks.

This file is the contract for anyone (human or Codex) changing the code.

---

## Non-negotiables

1. **The model may only cite message ids supplied in its prompt.** Every answer
   is validated against the window; an invented id, a URL, a control character
   or an unknown field fails the answer and falls back to the local voice.
   Never render model-authored usernames or quotes.
2. **Confidence is measured, not asserted.** `src/chat/cluster.js` computes the
   share of unique chatters in the leading stance, shrunk toward 50% for small
   samples. The model never sets it; the contract forbids a `confidence` field.
3. **Deleted means deleted.** `channel.chat.message_delete` removes the message
   from the window immediately, and deleted ids can never be re-added. The same
   applies to links, PII, commands, bots, blocked terms and floods — they are
   removed *before* clustering, so they cannot reach a prompt or a receipt.
4. **No chat posting.** Acclamation speaks through the overlay audio only. A
   chat bot that posts messages is a Twitch review risk and adds nothing to the
   demo.
5. **Zero runtime dependencies.** Node's built-in WebSocket client, `node:http`,
   `node:sqlite` and canvas keep `npm install` a no-op. Do not add a dependency
   without deleting something of equal weight.
6. **Unique chatters are the unit of consensus.** One spammer cannot invent a
   majority; per-user caps and dedupe live in `src/chat/window.js`.

---

## Commands

| Command | What it does |
| --- | --- |
| `npm test` | 83 tests, no network, ~1.5s |
| `npm start` | dashboard on `http://127.0.0.1:8787`, overlay on `/overlay` |
| `npm run replay` | offline fixture through the real EventSub client + full pipeline |
| `npm run replay -- --fixture replay/fixtures/dissent.jsonl` | split-mode demo |
| `npm run replay -- --serve` | replay data + live dashboard/overlay (no Twitch) |
| `npm run auth` | one-time Twitch OAuth, writes `.tokens.json` (mode 600) |
| `npm run doctor` | live go/no-go: token, scopes, real socket, real chat message |
| `node scripts/doctor.js --wait=20` | same, shorter wait |

Fixture format is JSONL; one event per line:

```json
{"t":0,"type":"chat","id":"c01","user":"mochirose","text":"you're gonna choke at 20"}
{"t":1900,"type":"delete","id":"c02"}
{"t":2400,"type":"raid","user":"toast","viewers":81}
{"t":2800,"type":"subscribe","user":"sadgirl","tier":"1000"}
```

`t` is milliseconds, `speed` divides it (default 20x).

Clustering is lexical by default. Set `ACCLAMATION_EMBEDDINGS=openai` and
`LLM_API_KEY` to opt in to semantic clustering; `EMBEDDINGS_MODEL` defaults to
`text-embedding-3-small`. The provider uses `LLM_BASE_URL` and falls back to
lexical clustering if the key is missing or the embedding request fails.

---

## The live leg

- Endpoint: `wss://eventsub.wss.twitch.tv/ws` (optional
  `?keepalive_timeout_seconds=10..600`).
- First frame is `session_welcome`; it carries the session id and the keepalive
  window. Subscriptions are created over Helix and bound to that session id.
- No notification/keepalive inside the keepalive window ⇒ socket is dead.
- `session_reconnect` carries a URL; connect there, wait for its welcome, then
  close the old socket. The session id is unchanged.
- A plain disconnect loses everything: resubscribe after the next welcome.
  `src/server/main.js` keeps the last session id and skips duplicate
  subscriptions when `session_reconnect` re-announces the same session.
- The server only ever accepts pongs from the client (EventSub is
  server → client); Node's WebSocket handles ping/pong automatically.

### Subscription types (version 1)

| Type | Condition | Scope |
| --- | --- | --- |
| `channel.chat.message` | `broadcaster_user_id`, `user_id` (the token user) | `user:read:chat` |
| `channel.chat.message_delete` | `broadcaster_user_id`, `user_id` | `user:read:chat` |
| `channel.raid` | `to_broadcaster_user_id` | none |
| `channel.subscribe` | `broadcaster_user_id` | `channel:read:subscriptions` (optional) |
| `channel.ban` | `broadcaster_user_id` | `channel:moderate` (optional) |
| `channel.unban` | `broadcaster_user_id` | `channel:moderate` (optional) |

OAuth scopes requested by `npm run auth`: `user:read:chat`,
`channel:read:subscriptions` and `channel:moderate`. The latter two are
optional; without them, subscribe hype or ban/unban scrubbing is skipped.
Redirect URI must exactly match the Twitch app registration, default
`http://localhost:8917/callback`.

If the token belongs to a different user than `TWITCH_CHANNEL`, chat reads
require `user:bot` + `channel:bot` and moderator status. Doctor refuses that
configuration on purpose; authorize the channel you stream on.

---

## Code map

| Path | Responsibility |
| --- | --- |
| `src/config.js` | env parsing (no dotenv), defaults, token file, scopes |
| `src/chat/scrub.js` | intake rules: links, PII, commands, bots, blocked terms, walls |
| `src/chat/window.js` | rolling window, dedupe, per-user cap, delete/ban scrubbing |
| `src/chat/cluster.js` | stemming, prototype clustering, `measureConsensus()` |
| `src/llm/prompt.js` | compact prompt payload + sample message ids |
| `src/llm/contract.js` | strict JSON contract + grounding validation |
| `src/llm/provider.js` | OpenAI-compatible chat completions (timeout, retry) |
| `src/llm/embeddings.js` | optional OpenAI-compatible embeddings and in-memory cache |
| `src/llm/local.js` | deterministic voice used offline or on model failure |
| `src/core/session.js` | orchestration: ingest → cluster → ask → validate → emit → remember |
| `src/eventsub/client.js` | EventSub WebSocket protocol, reconnect, watchdog, dedupe |
| `src/eventsub/helix.js` | validate token, resolve user, create/delete subscriptions |
| `src/memory/store.js` | SQLite lore/calls/scoreboard, in-memory fallback |
| `src/server/http.js` | dashboard API, SSE, overlay/TTS static serving |
| `src/server/main.js` | live wiring, resubscribe-on-welcome, lifecycle |
| `replay/fake-eventsub.js` | RFC 6455 + EventSub protocol server for offline development |
| `replay/replay.js` | fixture runner and `--serve` mode |
| `overlay/` | canvas glyph swarm, face mask, dissent fracture, SSE |
| `web/` | control room dashboard |
| `scripts/auth.js`, `scripts/doctor.js` | OAuth and the day-one gate |
| `test/` | 83 tests, network-free |

Request flow:

```
EventSub ──► ChatWindow (scrub/delete/dedupe) ──► snapshot
                                                   │
                        clusterMessages + measureConsensus
                                                   │
                    prompt (samples + ids) ──► model ──► contract validation
                                                   │              │
                                                   └── rejects ──► local voice
                                                                  │
                          SSE "answer" ──► overlay face + receipts + TTS
```

---

## Latency budget (on stage)

| Step | Budget | Where enforced |
| --- | --- | --- |
| Key press → glyphs start converging | < 200 ms | `trigger:start` is emitted before clustering; overlay reacts immediately |
| Window snapshot + lexical clustering (1–800 messages) | < 40 ms | synchronous, measured locally; opt-in embeddings add a network request |
| Model JSON answer | p50 ≈ 1.2 s, p95 < 3 s | `LLM_TIMEOUT_MS` (default 6000) + one repair attempt |
| Fallback to local voice if the model fails | < 5 ms | `composeLocalAnswer` |
| TTS start | browser voice immediate; server TTS ≈ 1 s | overlay `/api/tts` |

If you change the pipeline, measure `answer.timings.totalMs` and keep the
glyphs reacting before the text lands. The face must never wait on the model.

---

## Testing

- `test/helix.test.js` pins the subscription type/condition/transport shapes the live
  leg depends on, without needing a Twitch token.
- `test/eventsub.test.js` runs the production client against the fake server,
  including reconnect and keepalive-watchdog paths (sub-second keepalives are a
  test affordance; real Twitch enforces ≥10s).
- `test/session.test.js` stubs the model to prove grounded receipts, repair,
  fallback, refusal and the "one answer at a time" lock.
- `test/replay.test.js` runs the whole pipeline against real fixtures and
  asserts a deleted message is never quoted.
- The fake server uses Node's own WebSocket client in tests, so a protocol bug
  fails the suite rather than the demo.

Add a test for any change to scrub, window, clustering, contract or the
EventSub state machine. Those are the five things judges poke.

---

## Known limits (say them out loud, don't hide them)

- Lexical clustering is the default. Unusual phrasing can over-split and lower
  confidence; opt-in embeddings can group paraphrases when a provider is set.
- `channel.ban` and `channel.unban` scrub and release users when the token has
  `channel:moderate`; otherwise Helix reports those optional subscriptions as
  skipped.
- Server-side token refresh happens at startup only; a very long stream should
  restart or rely on the browser voice. A refresh timer is a one-liner where
  `ensureFreshToken` is already called.
- `node:sqlite` is experimental; the in-memory store keeps the app working but
  lore/scoreboard will not persist.
- The overlay's browser TTS is good enough for a demo; ElevenLabs-class voices
  are a provider swap in `overlay/face.js` + `/api/tts`.

---

## Where to take it next (in priority order)

1. **Sub-minute memory**: store per-stream highlights and let the model reference
   last stream's calls ("chat called the 20-choke run last week").
2. **Stream Deck plugin**: a 60-line HTTP action hitting `POST /api/trigger`;
   the dashboard button is the fallback.
3. **Split voice staging**: currently two voices are concatenated; give each
   voice its own pitch/speed and a 200ms interleave in the browser TTS.
