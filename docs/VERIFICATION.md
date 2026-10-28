# Verification record

Recorded 2026-10-28. The local commands used Node v25.2.1 and the repository's
offline fixtures. The tests and replay harness need permission to bind local
`127.0.0.1` sockets; the restricted sandbox initially denied those binds, and
the runs below succeeded with that permission.

| Check | Command or evidence | Result | Source |
| --- | --- | --- | --- |
| Baseline tests | `npm test` | 83 passing, 0 failing | Local, Node v25.2.1 |
| CI at `78031f4` | [GitHub Actions run 40671836604](https://github.com/zalkabsi/ACCLAMATION/actions/runs/40671836604) | Node 22.19 and 24 jobs passed, including tests and replay | CI |
| Consensus replay | `node --disable-warning=ExperimentalWarning replay/replay.js --fixture replay/fixtures/consensus.jsonl --speed 100000` | CONSENSUS; 87% confidence; local voice | Local |
| Dissent replay | `node --disable-warning=ExperimentalWarning replay/replay.js --fixture replay/fixtures/dissent.jsonl --speed 100000` | DISSENT; split 43/29; local voice | Local |
| Messy replay | `node --disable-warning=ExperimentalWarning replay/replay.js --fixture replay/fixtures/messy.jsonl --speed 100000` | INSUFFICIENT; 3 chatters; 12 blocked | Local |
| Overlay at 1920×1080 | [Consensus screenshot](overlay-consensus.png), [dissent screenshot](overlay-dissent.png) | Both existing PNGs are 1920×1080. Manual inspection shows complete faces and separated receipts. | Manual, existing images |
| Overlay at 1280×720 | Render the overlay at 1280×720 | Not independently verified in this session; the two checked-in PNGs are 1920×1080. | Manual, pending |
| Browser voice and `?mute=1` | Exercise both in a browser or OBS | Browser access was unavailable. The source contains the browser speech path and mute guard, but playback and mute behavior have not been runtime-verified. | Manual, pending |
| Live Twitch leg | `npm run auth`, then `npm run doctor` with chat active | **Not verified.** Credentials are needed; the doctor is the gate and exits successfully only after a real chat message arrives. | Manual, pending |

## Captured baseline output

<details>
<summary><code>npm test</code> output</summary>

```text

> acclamation@0.1.0 test
> node --disable-warning=ExperimentalWarning --test test/*.test.js

✔ stemming collapses the variations chat actually types (1.576875ms)
✔ a one-sided room becomes one stance with a high share (1.723958ms)
✔ a split room is detected and reports both shares (0.566583ms)
✔ two chatters are not a crowd (0.216ms)
✔ an emote wall is reported as unclear, not as agreement (0.465416ms)
✔ scattered takes with no side over 40% are unclear, not invented consensus (1.09125ms)
✔ clustering is deterministic and capped (2.086833ms)
✔ embedding vectors cluster paraphrases that share no lexical tokens (0.5765ms)
✔ failed embeddings fall back to the unchanged deterministic lexical result (0.846417ms)
✔ representatives are distinct users and carry real message ids (0.5235ms)
✔ env parsing handles comments, quotes and export prefixes (0.723ms)
✔ provider defaults to local without a key and openai with one (0.37525ms)
✔ embedding clustering is opt-in and requires the OpenAI key (0.210208ms)
✔ invalid numbers and providers fail loudly (0.224666ms)
✔ a token file is read without exposing the token in public config (3.101042ms)
✔ a grounded consensus answer passes and its quotes come from the window (1.116375ms)
✔ invented receipts are rejected (0.205208ms)
✔ an answer with no valid receipt is rejected (0.272625ms)
✔ URLs in the spoken text are rejected (0.20225ms)
✔ the answer may not change the measured mode (0.149ms)
✔ unknown fields and wrong versions are rejected (0.178625ms)
✔ a valid dissent answer keeps the two voices apart (0.31475ms)
✔ dissent requires exactly two voices with distinct receipts (0.199458ms)
✔ dissent may not smuggle a top-level stance (0.169208ms)
✔ model output is parsed out of fences and preamble, but prose is rejected (1.95825ms)
✔ OpenAI embedding client batches unique text and restores input order from response indexes (1.49525ms)
✔ welcome carries the session id and notifications are delivered (25.526583ms)
✔ keepalive messages reset the health timer (255.55825ms)
✔ duplicate deliveries are ignored (254.907125ms)
✔ a server-initiated reconnect keeps the same session and resumes events (9.088916ms)
✔ a dead socket is detected by the keepalive watchdog and replaced (412.36375ms)
✔ stop() prevents any further reconnect attempts (404.636125ms)
✔ chat subscriptions carry the conditions Twitch actually requires (3.954958ms)
✔ subscription requests are bound to the websocket session id (37.335917ms)
✔ an existing subscription is reported instead of treated as an error (0.344792ms)
✔ Twitch API errors surface the message and status (1.836375ms)
✔ user lookup returns the channel and rejects an unknown login (0.894417ms)
✔ token validation uses the OAuth header and reports an expired token (0.438292ms)
✔ subscribeAll skips the optional types when scopes are missing (0.539875ms)
✔ subscribeAll creates ban and unban subscriptions with the documented scope (0.449916ms)
✔ subscribeAll reports failures without aborting the rest (0.912875ms)
✔ sqlite store persists lore, calls and the scoreboard (5.358042ms)
✔ in-memory store exposes the same interface (0.160209ms)
✔ empty lore is rejected (0.167292ms)
✔ prompt samples only contain accepted message ids (0.615209ms)
✔ payload is bounded and carries the measured numbers (0.057416ms)
✔ allowed ids are exactly the window messages, nothing more (0.0645ms)
✔ the system prompt carries the untrusted-data guard and forbids confidence (0.113417ms)

  ── CONSENSUS · 87% confidence · local · 2ms (0ms model) ──

  All 10 chatters are on the same page. doodle said it first: “choking at 20 like always”
      @doodle: choking at 20 like always
      @beans: choke at 20 i'm calling it
      @lurker99: already choking at 20 sadge

  measured: 10 chatters · 11 messages · top share 100%
  safety: 12 accepted · 5 blocked at intake · 1 removed after accepting (duplicate: 2, link: 1, command: 1, bot: 1, deleted: 1)

✔ the replay harness drives the production path end to end (166.321084ms)

  ── INSUFFICIENT · no number · local · 1ms (0ms model) ──

  Only 3 people have said anything. That is not a crowd yet — ask again in a minute.

  measured: 3 chatters · 3 messages · top share 33%
  safety: 3 accepted · 12 blocked at intake · 0 removed after accepting (link: 3, pii_email: 1, pii_phone: 1, bot: 2, command: 2, duplicate: 3)

✔ the messy fixture is refused instead of inventing a consensus (143.906708ms)
✔ links are detected without false positives (0.954417ms)
✔ email and phone are labelled as personal data, not links (1.031625ms)
✔ blocked terms match whole words and phrases (0.131208ms)
✔ commands, bots, blocked users and non-text messages are rejected (0.105ms)
✔ empty and wall-of-text messages are rejected (0.059792ms)
✔ links are allowed when the channel opts in, but PII never is (0.055584ms)
✔ normalizeText and redact keep display output safe (0.271083ms)
✔ health and state endpoints expose the room without secrets (16.185459ms)
✔ trigger produces a measured answer and records it in state (8.3955ms)
✔ scores, lore and static pages are served (6.370792ms)
✔ the SSE stream opens with a hello event (3.360833ms)
✔ unknown routes return JSON 404s (1.126375ms)
✔ the local voice answers from the measured window and records the call (6.279916ms)
✔ the overlay starts forming before asynchronous embedding clustering finishes (0.674334ms)
✔ a valid model answer is used and its receipts are resolved from the window (0.56575ms)
✔ an invented receipt is repaired once, then rejected in favour of the local voice (0.423041ms)
✔ a provider failure falls back to the local voice instead of failing the trigger (0.975083ms)
✔ too little chat is refused before the model is ever called (0.248833ms)
✔ a deleted message can never appear in an answer (0.26425ms)
✔ a channel ban removes that chatter from the next answer receipts (0.28025ms)
✔ a channel unban allows fresh messages without restoring scrubbed receipts (0.693042ms)
✔ split chat produces two voices, and forcing dissent on one stance does not invent a split (0.570625ms)
✔ only one answer runs at a time (0.358209ms)
✔ hype events and scoreboard updates are emitted (0.220541ms)
✔ accepts a message and reports it in the snapshot (1.312ms)
✔ deleted messages are removed and can never be re-added (0.426ms)
✔ banning a user scrubs their existing messages and future ones (0.117625ms)
✔ unbanning permits new messages but never restores scrubbed message ids (0.6845ms)
✔ duplicate messages and per-user floods are rejected (0.139834ms)
✔ blocked terms and bots are filtered before they reach the window (0.157ms)
✔ messages evict after the window elapses (0.134042ms)
✔ timestamps are clamped into the window (0.080291ms)
✔ the oldest message is dropped when the window cap is hit (0.178375ms)
ℹ tests 83
ℹ suites 0
ℹ pass 83
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1522.5605
```

</details>

The replay commands were run in this order:

```sh
node --disable-warning=ExperimentalWarning replay/replay.js --fixture replay/fixtures/consensus.jsonl --speed 100000
node --disable-warning=ExperimentalWarning replay/replay.js --fixture replay/fixtures/dissent.jsonl --speed 100000
node --disable-warning=ExperimentalWarning replay/replay.js --fixture replay/fixtures/messy.jsonl --speed 100000
```

<details>
<summary>Replay output</summary>

```text

  ── CONSENSUS · 87% confidence · local · 3ms (0ms model) ──

  All 10 chatters are on the same page. doodle said it first: “choking at 20 like always”
      @doodle: choking at 20 like always
      @beans: choke at 20 i'm calling it
      @lurker99: already choking at 20 sadge

  measured: 10 chatters · 11 messages · top share 100%
  safety: 12 accepted · 5 blocked at intake · 1 removed after accepting (duplicate: 2, link: 1, command: 1, bot: 1, deleted: 1)


  ── DISSENT · 68% confidence · local · 3ms (0ms model) ──

  A (the loud half): 43% of chat is with toast: “win easy, cracked actually”
      @toast: win easy, cracked actually
      @beans: he's so cracked, win
  B (the other half): 29% is not having it — sadgirl: “washed, he chokes every time”
      @sadgirl: washed, he chokes every time
      @kayluv: washed player, he will choke

  measured: 14 chatters · 14 messages · top share 43% · split 43/29
  safety: 14 accepted · 0 blocked at intake · 0 removed after accepting


  ── INSUFFICIENT · no number · local · 2ms (0ms model) ──

  Only 3 people have said anything. That is not a crowd yet — ask again in a minute.

  measured: 3 chatters · 3 messages · top share 33%
  safety: 3 accepted · 12 blocked at intake · 0 removed after accepting (link: 3, pii_email: 1, pii_phone: 1, bot: 2, command: 2, duplicate: 3)
```

</details>
