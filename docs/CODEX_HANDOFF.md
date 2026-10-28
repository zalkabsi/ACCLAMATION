# Codex handoff

Paste this into a **new Codex thread** opened at `/Users/z/ACCLAMATION`, then do
the work in that thread. At the end, `/status` in that thread gives the session
ID the hackathon asks for. Nothing here is busywork: every task is real product
work, so the thread is genuinely part of the build.

---

## First message to Codex

> Read `AGENTS.md` before doing anything. This repo is **Acclamation**, a Twitch
> tool: it collapses live chat into one character using EventSub, measures the
> room's stance by clustering, and answers through an OBS overlay in one voice
> (or two, in split mode). It has zero runtime dependencies and 74 network-free
> tests.
>
> Current state: `npm test` is green; `npm run replay` works offline; the repo is
> pushed and CI runs on Node 22.19 + 24. The live Twitch leg is implemented but
> not yet demonstrated. Credentials may be present in `.env` (never commit it).
>
> Work through the tasks below in order. Keep every test green, add tests for new
> behavior, and commit per task. Do not add runtime dependencies. Do not weaken
> the invariants in `AGENTS.md` — especially: the model may only cite supplied
> message ids, confidence is measured not asserted, and deleted/filtered
> messages can never be quoted.

## Tasks

1. **Baseline.** Run `npm test` and `node --disable-warning=ExperimentalWarning
   replay/replay.js --fixture replay/fixtures/dissent.jsonl --speed 100000`.
   Confirm 74 tests and the dissent answer.
2. **Live leg.** If `.env` has `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET` and
   `TWITCH_CHANNEL`, run `npm run auth` (browser consent), then
   `npm run doctor --wait=90` while someone types in chat. Fix anything the
   doctor reports (scopes, redirect URI, user/channel mismatch, subscription
   errors). Acceptance: the doctor prints `REAL CHAT ARRIVED`.
3. **Record the proof.** On success, update the README "What is verified" table:
   change the live row from ⏳ to ✅ with the date and channel login. Add the
   doctor output (redact token values) to `docs/DEMO.md` under pre-flight.
4. **Embedding clustering (stretch, only if the live leg is done).** Implement
   `clusterMessages(messages, { embed })` in `src/chat/cluster.js`: cosine
   clustering over embeddings when a provider is configured, lexical fallback
   otherwise, same output shape. Add tests with a deterministic fake embedder
   proving the fallback still passes and that two paraphrases with no shared
   tokens cluster together. Wire an embedding provider in `src/llm/` behind
   `ACCLAMATION_EMBEDDINGS=openai` (no key ⇒ lexical).
5. **`channel.ban` scrubbing.** Add the subscription (`channel.ban`, scope
   `moderator:read:banned_users` — verify the condition fields in Twitch docs
   before coding), route `channel.ban` and `channel.unban` events into
   `session.ingest`, call `window.banUser()` / a new `unban` path, and add tests
   proving a banned user's messages disappear from the next answer's receipts.
   Update `scripts/doctor.js` to report the new subscription.
6. **Demo polish.** At 1280×720 and 1920×1080, confirm the overlay renders a full
   face (the mask shuffle fix) and receipts don't overlap. If `TTS_PROVIDER=openai`
   is configured, verify `/api/tts` streams; otherwise confirm the browser voice
   path and `?mute=1`.

## Definition of done

- `npm test` green (more than 74 tests), `npm run replay` still works.
- Doctor prints a real chat message; README status table reflects it honestly.
- One commit per task, conventional messages.
- `/status` in this thread copied into the submission.

## Guardrails

- `.env`, `.tokens.json`, `.data/` are gitignored — keep them out of commits.
- No secret ever goes into a prompt, a screenshot or the README.
- If a task cannot be done (no credentials, provider down), say so in the thread
  and move on — do not fake a result.
