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
> (or two, in split mode). It has zero runtime dependencies and 83 network-free
> tests.
>
> Current state: `npm test` is green; `npm run replay` works offline; the repo is
> pushed and CI runs on Node 22.19 + 24. On 2026-10-29 the doctor received a real
> Twitch chat event. A separate live app test emitted an answer on the overlay
> event stream. Browser display and audio remain unchecked; reconnect status
> needs investigation. Credentials may be present in `.env` (never commit it).
>
> Work through the tasks below in order. Keep every test green, add tests for new
> behavior, and commit per task. Do not add runtime dependencies. Do not weaken
> the invariants in `AGENTS.md` — especially: the model may only cite supplied
> message ids, confidence is measured not asserted, and deleted/filtered
> messages can never be quoted.

## Tasks

1. **Baseline.** Run `npm test` and `node --disable-warning=ExperimentalWarning
   replay/replay.js --fixture replay/fixtures/dissent.jsonl --speed 100000`.
   Confirm 83 passing tests and the dissent answer.
2. **Live doctor — real chat received; reconnect issue pending.** On 2026-10-29,
   the doctor received a real chat event and exited 0. An earlier attempt missed
   a keepalive and the doctor did not recreate its subscriptions after
   reconnecting. In a separate main-server test, subscriptions were recreated
   after a forced pause but the reported status remained `reconnecting`.
3. **Done — record the proof.** The README, `docs/DEMO.md` and
   `docs/VERIFICATION.md` record the successful doctor run. Account identifiers,
   credentials and chat text are omitted.
4. **Done — embedding clustering** (`eddcdc1`). `clusterMessages` uses cosine
   similarity with an opt-in embedding provider and
   falls back to lexical clustering. Deterministic tests cover paraphrases and
   fallback; `ACCLAMATION_EMBEDDINGS=openai` enables the provider with a key.
5. **Done — ban/unban scrubbing** (`155f1cf`). Both subscriptions use
   `broadcaster_user_id` and optional `channel:moderate`; notifications route
   through `session.ingest`, and tests cover scrubbing and unban. The doctor
   reports the subscription results.
6. **Demo polish.** At 1280×720 and 1920×1080, confirm the overlay renders a full
   face (the mask shuffle fix) and receipts don't overlap. If `TTS_PROVIDER=openai`
   is configured, verify `/api/tts` streams; otherwise confirm the browser voice
   path and `?mute=1`. The checked-in overlay screenshots are 1920×1080; the
   1280×720 and browser audio checks still need independent verification.

## Definition of done

- `npm test` green (83 tests), `npm run replay` still works.
- Doctor prints a real chat message; README status table reflects it honestly.
- One commit per task, conventional messages.
- `/status` in this thread copied into the submission.

## Guardrails

- `.env`, `.tokens.json`, `.data/` are gitignored — keep them out of commits.
- No secret ever goes into a prompt, a screenshot or the README.
- If a task cannot be done (no credentials, provider down), say so in the thread
  and move on — do not fake a result.
