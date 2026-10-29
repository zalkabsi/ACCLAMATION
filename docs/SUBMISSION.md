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
  `channel.chat.message_delete`, `channel.raid`, `channel.subscribe`,
  `channel.ban`, `channel.unban`), Helix for subscriptions, authorization-code
  OAuth with `user:read:chat` and optional `channel:read:subscriptions` and
  `channel:moderate`.
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

In a documented follow-up thread, Codex worked from `AGENTS.md` to add opt-in
embedding clustering and ban/unban scrubbing, then helped verify the project.
The suite has 83 network-free tests, and a real Twitch chat event reached the
doctor. The original project was already present when that follow-up began.

**Follow-up session ID:** `01a181e5-4d0e-7793-a5de-07af087f8982`.
**Main build session ID:** `<confirm from the original build thread>`.

## Devpost long answers

### How Acclamation meets the main technology requirement

The requirement has two halves — build **for Twitch streamers and their
community**, and build it **with OpenAI Codex** — and both are load-bearing
rather than decorative.

**Twitch is the product surface.** Acclamation is designed to authenticate
through Twitch OAuth, open an EventSub WebSocket session, and consume
`channel.chat.message`, `channel.chat.message_delete`, `channel.raid`,
`channel.subscribe`, `channel.ban` and `channel.unban` live. On 2026-10-29,
`npm run doctor` received a real chat event. A separate live app test ingested a
real message and emitted an insufficient-chat answer on the overlay event
stream; browser display and audio still need to be verified.
The offline replay feeds fixtures through a fake EventSub server. It ships as
an OBS browser-source overlay, which means no Extension review and no chatbot
review; the streamer installs a URL and talks to their chat.

**Codex is the build method.** `AGENTS.md` records the contract: OAuth scopes,
EventSub subscription versions and conditions, safety invariants, the latency
budget, and the file map. In the documented follow-up thread, Codex added
semantic clustering and ban/unban scrubbing with tests. The repository also has
a fake EventSub WebSocket server for offline development, and the suite has 83
tests with no network or API key. Confirm the original build thread and its ID
before making claims about that part of the work.

**AI is the product, not a feature.** The model writes the crowd's voice and,
in split mode, both arguing voices. It is deliberately not trusted with facts:
the stance share is computed by clustering, receipts are message IDs resolved
locally, and a validator rejects invented IDs, URLs and mode changes. Remove the
model and you still have a measurement tool; remove the measurement and the
voices are fiction. Both are required.

### How streamers and their community use it

**The streamer** installs one OBS browser source and keeps one dashboard tab
open. During a stream they hit **Ask chat** — or a Stream Deck key wired to
`POST /api/trigger` — when a moment is worth interrogating: a boss attempt, a
prediction, a questionable play, the aftermath of a raid. The glyphs stop
drifting and form a face; the answer lands in one voice with a measured
confidence and a row of receipts. The streamer can push back — "do you actually
all think that?" — and hit **Dissent**, and the face breaks into two voices that
argue on stream. Raids and subs pop a banner and the face reacts without any
setup. Between streams the same dashboard holds the channel lore and the
**Streamer vs Chat** record: pin "chat still calls the 20-choke run", settle who
was right with the two score buttons, and the next stream still remembers it.

**The community** does nothing new. No commands, no extension, no sign-up and no
bot messages: viewers just chat, and their messages *are* the character. Every
message in the rolling 120-second window becomes a glyph in the face, and the
receipts on screen carry real usernames and real quotes, so being quoted is
recognisable. When the room is split, both halves get their own voice and colour
— the argument is the content instead of a poll result. When there are too few
chatters, Acclamation says "that is not a crowd yet" rather than inventing a
consensus. A deletion or a ban notification with `channel:moderate` removes the
affected messages from the window for subsequent triggers. An answer already in
flight can use its earlier snapshot. Links, personal information and bot noise
are filtered at intake.

**Why the loop works on Twitch.** It gives the streamer a rival that is their own
audience — three repeatable beats: ask, argue, remember. It gives viewers
representation with their name attached. It gives moderators controls that take
effect immediately, and it never posts into chat, so it changes nothing about
how the channel is run.

**First five minutes on a real channel:** add the browser source, ask one
question mid-game, read the receipts out loud, force dissent when chat disagrees,
then pin one line and settle the score after the game.

### How we used Codex

1. **Contract.** The follow-up began with `AGENTS.md`, which records the EventSub
   rules, safety invariants, latency budget and repository map.
2. **Clustering.** Codex added opt-in embedding clustering with a lexical fallback
   and deterministic tests (`eddcdc1`).
3. **Moderation.** Codex added ban/unban subscription handling and tests for
   scrubbing affected users from the window (`155f1cf`).
4. **Verification.** The follow-up recorded the replay fixtures, the 83-test
   suite and CI on Node 22.19 and 24. The doctor received a real Twitch chat
   event, and a separate app test emitted an answer on the overlay event stream;
   browser display and audio still need a manual check.

The original project predated the documented follow-up. Confirm the original
build thread and its session ID before describing work from that thread.

### How Acclamation connects to Twitch

- **OAuth (Authorization Code).** `npm run auth` opens Twitch's consent page on
  `http://localhost:8917/callback`, requests `user:read:chat` and optional
  `channel:read:subscriptions` and `channel:moderate`, and writes a local,
  gitignored token. The token must belong to the channel being read; the doctor
  enforces that.
- **EventSub WebSocket** (`wss://eventsub.wss.twitch.tv/ws`). The first frame is
  `session_welcome`, carrying the session ID and keepalive window. If no
  notification or keepalive arrives in that window, the client reconnects; if
  Twitch sends `session_reconnect`, the client connects to the new URL, waits
  for its welcome, then closes the old socket so nothing is dropped.
- **Helix.** Subscriptions are created with
  `POST /helix/eventsub/subscriptions`, each bound to the WebSocket session ID:
  - `channel.chat.message` — `broadcaster_user_id`, `user_id` (`user:read:chat`)
  - `channel.chat.message_delete` — same condition (`user:read:chat`)
  - `channel.raid` — `to_broadcaster_user_id`, no scope
  - `channel.subscribe` — `broadcaster_user_id`, `channel:read:subscriptions`
  - `channel.ban` — `broadcaster_user_id`, `channel:moderate`
  - `channel.unban` — `broadcaster_user_id`, `channel:moderate`
- **Delivery without posting to chat.** Events go to the dashboard and the
  OBS overlay over local SSE. Acclamation never posts to chat: audio is produced
  by the overlay page itself, which keeps it outside chatbot review and makes the
  demo work on any channel without bot permissions.

### Products used

| Product | What it does in Acclamation |
| --- | --- |
| **OpenAI Codex** | Follow-up development and verification guided by `AGENTS.md`; the original build session ID still needs confirmation. |
| **OpenAI API — Chat Completions** | Turns measured clusters and sample message IDs into the single stance, or the two voices in split mode. Strict JSON only; default model `gpt-4o-mini`, any OpenAI-compatible endpoint configurable. |
| **OpenAI Text-to-Speech** (optional) | Streams the answer voice to the overlay through a local `/api/tts` proxy when `TTS_PROVIDER=openai`. The default is the browser's speech synthesis, so the demo needs no second key. |
| **Twitch EventSub** | Real-time chat, message deletion, raids and subscriptions — the live data that becomes glyphs, stances and receipts. |
| **Twitch Helix** | Creates and deletes the EventSub subscriptions and resolves the broadcaster's channel. |
| **Twitch OAuth** | Authorization-code login, scope grants, token validation and refresh. |
| **Twitch chat** | The content itself: every message is a glyph, a cluster vote, or a receipt. |
| **OBS Studio** | Captures the overlay as a transparent browser source, including its audio. |
| **Node.js 22.19+** | Runtime for the EventSub client, HTTP server, OAuth flow, replay harness and doctor; uses the built-in WebSocket client, `node:http` and `node:sqlite`. |
| **SQLite (`node:sqlite`)** | Persists channel lore, every call and the Streamer-vs-Chat scoreboard; falls back to memory if unavailable. |
| **Canvas 2D** | Renders the 800–2,000 glyph swarm and the face mask it converges into. |
| **GitHub + Actions** | Public repo for judging and CI (tests on Node 22.19 and 24, plus a replay smoke run). |

No Twitch Extension, bot framework or chat-posting library is used — that is a
deliberate scope choice, not an omission.

> **Before submitting:** replace the session ID with the real one from `/status`,
> and only keep the "Codex built most of this" wording if it matches your actual
> thread. The repo, the contract and the tests are real either way; the claim
> must be too.

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
- 83 tests covering clustering, ingestion filters, the JSON contract, the
  EventSub state machine (including reconnect and keepalive watchdog) and the
  full replay pipeline.
- A live-leg doctor that refuses to say "working" until a real chat message
  arrives over the socket.

## What we learned

- **Consensus is easy to fake and hard to measure.** The first clusterer used
  IDF-weighted centroids; as a cluster filled up, similarity to its own centroid
  diluted and nine people making the same joke split into seven "stances". Stemmed
  token matching against cluster prototypes fixed most of it, and shrinking
  confidence toward 50% on small samples made the numbers smaller — and true.
  A demo that reports 43/29 is more convincing than one that reports 96%.
- **Grounding is an architecture decision, not a prompt line.** "Never invent
  quotes" eventually fails if the model writes the quote. Making the model cite
  message ids and resolving the username and text locally turned the promise into
  a validator: invented ids are rejected, retried once, then replaced by the local
  voice. The audience never sees model-authored attribution.
- **Deletion is a systems problem.** A deleted message must be removed from the
  window, tombstoned so it cannot be re-added, excluded before clustering, absent
  from the prompt, and impossible to resolve as a receipt — with a test asserting
  the deleted fixture id never appears in an answer. Any one of those layers alone
  is a bug waiting for the worst possible moment.
- **Build the network boundary first.** The fake EventSub server (handshake,
  welcome, keepalive, reconnect, revocation) meant the overlay, clustering and
  dashboard never waited on Twitch credentials, and the reconnect state machine
  was tested in milliseconds instead of during a stream. The harness is why the
  live leg is a 20-minute setup instead of a day of blocked work.
- **Refusal is a feature.** Under four chatters Acclamation says "that is not a
  crowd yet" and never calls the model. It started as a safety rule; in rehearsal
  it became the most trustworthy beat in the demo — the one moment the audience
  believes the numbers.
- **Latency is composition.** The face starts forming on the trigger, before the
  model call finishes. If the audience ever sees a spinner, the product feels like
  an API instead of a character — so the animation is part of the architecture,
  not polish.

## What's next

Per-voice TTS staging in split mode; a Stream Deck action; cross-stream lore so
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
2. `npm test` → 83 tests pass, no network, no API key.
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
