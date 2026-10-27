# Devpost submission copy

Paste-ready fields for the Codex × TwitchCon Hackathon submission. Keep the
claims in sync with the README's status table — do not claim a live run that
`npm run doctor` has not produced.

---

## Project name

Acclamation

## Tagline

Your chat has a word. Now it has a voice.

## Short description (one sentence)

Acclamation turns a Twitch chat into a single character the streamer can
interrogate — measuring what the room actually thinks, answering out loud, and
quoting real chatters as receipts.

## Inspiration

Every team at a Twitch hackathon builds "AI replies to chat" or "chat controls
the game." Both keep the audience as a wall of text. Chat is already a collective
character — we wanted to give it a face, a mood and a voice, and let the streamer
argue with their own audience.

## What it does

Acclamation listens to a rolling window of real Twitch chat over EventSub. When
the streamer asks a question, it clusters the room into stances, measures the
share of unique chatters behind each one, and answers as a single voice — with
2–5 receipts quoting real usernames and messages. When chat is split, the glyph
face fractures into two and two voices argue with each other. A Streamer-vs-Chat
scoreboard and pinned channel lore persist across streams.

## Why it needs AI (and why AI isn't trusted with the facts)

The model writes the voice and the argument; it never writes the evidence. It
receives bounded sample messages with ids and must return strict JSON citing only
those ids. A validator resolves every receipt back to the real message locally,
rejects invented ids, URLs, unknown fields and mode changes, retries once, then
falls back to a deterministic local voice. Confidence is computed from the
clustered share of unique chatters — the model is forbidden from returning one.

## How we built it

- **Twitch:** EventSub WebSocket v1 (`channel.chat.message`,
  `channel.chat.message_delete`, `channel.raid`, `channel.subscribe`), Helix for
  subscriptions, authorization-code OAuth with `user:read:chat` and
  `channel:read:subscriptions`.
- **AI:** any OpenAI-compatible chat-completions endpoint; JSON-object mode when
  supported, strict local validation always.
- **Frontend:** canvas glyph swarm (one glyph per message) that samples a drawn
  face mask; pure HTML/CSS/JS, no build step, transparent for OBS.
- **Runtime:** Node 22+, zero dependencies. `node:sqlite` for lore, calls and the
  scoreboard, with an in-memory fallback.
- **Offline harness:** a fake EventSub WebSocket server (RFC 6455 handshake,
  welcome/keepalive/reconnect/notification/revocation) so the whole product
  could be built and tested without a Twitch account or network.

## How we used Codex

One thread held most of the build, guided by `AGENTS.md` (protocol facts, scope
list, invariants, latency budget). Codex wrote the EventSub client against the
fake server first, then the scrubber/window/clustering/contract stack with tests,
then the overlay and dashboard. The tests were the review mechanism: every
invariant in `AGENTS.md` has a test, and the fake server means the suite runs
offline in about 1.5 seconds. **Codex session ID:** `<paste from /status>`.

## Challenges

- **Making consensus falsifiable.** Lexical clustering over-splits short chat;
  prototypes and stemming fixed most of it. The confidence shrinks honestly on
  small samples instead of overclaiming.
- **Grounding.** Letting the model write quotes is how every similar project
  eventually quotes a deleted message. We made the model cite ids, and resolved
  text locally.
- **Deleted messages.** The scrub has to happen on the window, before clustering,
  and ids need tombstones — tested end to end.
- **Demo latency.** The face starts forming on `trigger:start`, before the model
  call, so the audience never watches a spinner.

## Accomplishments

- A split-mode moment that is genuinely new on a Twitch stream: one chat, two
  voices, one face breaking in half.
- 66 tests covering clustering, ingestion filters, the JSON contract, the
  EventSub state machine (including reconnect and keepalive watchdog) and the
  full replay pipeline.
- A live-leg doctor that refuses to say "working" until a real chat message
  arrives over the socket.

## What's next

Embedding-based clustering; `channel.ban` for instant timeout scrubbing;
per-voice TTS staging in split mode; a Stream Deck action; cross-stream lore so
chat's calls follow the channel.

## Built with

Twitch EventSub, Twitch Helix, OAuth, OpenAI-compatible LLMs, Node.js, WebSocket,
canvas, SQLite.

## Links

- Repo: https://github.com/zalkabsi/ACCLAMATION (public)
- Video: `<YouTube URL, public>`
- Demo (offline): `npm test && npm run replay`

---

## Judge test instructions (put this in the Devpost description or a pinned file)

1. `git clone` the repo; Node 22.19+.
2. `npm test` → 66 tests pass, no network, no API key.
3. `npm run replay` → prints a measured consensus answer with receipts and
   held-back counts.
4. `npm run replay -- --fixture replay/fixtures/dissent.jsonl` → split mode.
5. `npm run replay -- --serve` → open `http://127.0.0.1:8787/overlay?stage=1`
   and `http://127.0.0.1:8787` to see the face and the dashboard.
6. Live (optional, needs credentials): `npm run auth`, `npm run doctor`,
   `npm start`.

## Repository sharing

The repo is **public**, so judges and `testing@devpost.com` can read it without
an invitation. Verify it in a logged-out/incognito window before submitting —
a repo that was private when the link was copied is the classic silent failure.
If it ever needs to go private again, invite `testing@devpost.com` as a
collaborator and confirm the invitation is accepted.

## Submission checklist

- [ ] Repo contains source, fixtures, `AGENTS.md`, README, `.env.example`
- [x] Repo is public (re-check in a logged-out window)
- [ ] `npm test` green from a clean clone (no `node_modules` needed)
- [ ] `npm run replay` works with no API key
- [ ] 3-minute video uploaded to YouTube, public, shows the overlay running and
      Codex usage
- [ ] Codex session ID copied from `/status` (the thread where most of the build
      happened)
- [ ] Description mentions the doctor and what is not proven until a live
      message arrives
- [ ] Twitch app redirect URI is `http://localhost:8917/callback` in the README
- [ ] No `.env`, `.tokens.json` or `.data/` committed (`git status` clean of them)
