# Codex follow-up — finish the documentation and verification record

Paste the block below into the **same Codex thread** that added embedding
clustering and ban scrubbing (session `01a181e5-4d0e-7793-a5de-07af087f8982`).
Do not start a new thread if you can resume that one — the session ID is the
submission artifact.

---

> Read `AGENTS.md`. This is Acclamation. A previous turn added opt-in embedding
> clustering (`eddcdc1`) and `channel.ban`/`channel.unban` scrubbing (`155f1cf`);
> `npm test` now reports 83 passing and CI is green on `78031f4`. Two commits
> (`4abbe04`, `78031f4`) claim to record verification but are empty — do not
> rewrite history; put the missing evidence in a new doc instead.
>
> Do not change runtime behavior. Do not touch `.env`, `.tokens.json` or
> `.data/`. Do not claim the live Twitch leg is verified — it is not (no
> credentials yet). Do not rewrite git history. Do not change the honesty note
> at the end of `docs/SUBMISSION.md`.
>
> **Task 1 — baseline (do not skip).** Run and capture the real output:
> - `npm test` → expect 83 passing, 0 failing. If it differs, stop and report.
> - `node --disable-warning=ExperimentalWarning replay/replay.js --fixture replay/fixtures/consensus.jsonl --speed 100000` → consensus answer, 87% confidence on the local voice.
> - `node --disable-warning=ExperimentalWarning replay/replay.js --fixture replay/fixtures/dissent.jsonl --speed 100000` → DISSENT, split 43/29.
> - `node --disable-warning=ExperimentalWarning replay/replay.js --fixture replay/fixtures/messy.jsonl --speed 100000` → INSUFFICIENT, 3 chatters, 12 blocked.
>
> **Task 2 — documentation sync (factual edits only).**
> a. `README.md` — replace the three `74 tests` occurrences (quickstart, verified table, repo map) with 83. Update the OAuth scopes line (~110) to `user:read:chat channel:read:subscriptions channel:moderate` and say the last two are optional. Add rows to the "What is verified" table for embedding clustering (`test/cluster.test.js`, `test/embeddings.test.js`) and ban/unban (`test/helix.test.js`, `test/window.test.js`). Add a "never quote a timed-out or banned user" row to the safety table. In the model section, document `ACCLAMATION_EMBEDDINGS=openai` + `EMBEDDINGS_MODEL` as opt-in semantic clustering with lexical fallback.
> b. `AGENTS.md` — two `74 tests` → 83; make sure the embeddings env vars are documented somewhere under configuration.
> c. `docs/DEMO.md` — two `74` → 83.
> d. `docs/SUBMISSION.md` — four `74` → 83. Add `channel.ban` / `channel.unban` to the subscription lists (~51, ~83, ~180) and `channel:moderate` to the scopes (~53, ~170). Remove the now-done embeddings and `channel.ban` items from "What's next" (~270), keeping per-voice TTS staging, Stream Deck and cross-stream lore.
> e. `.env.example` — add, after the model block:
>    ```
>    # Optional semantic clustering (needs a key; falls back to lexical)
>    ACCLAMATION_EMBEDDINGS=none
>    EMBEDDINGS_MODEL=text-embedding-3-small
>    ```
> f. `docs/CODEX_HANDOFF.md` — mark tasks 4 and 5 done; update test counts.
>
> **Task 3 — create `docs/VERIFICATION.md`.** A dated table: check, command,
> result, source (CI / local / manual). Include exactly what you observed:
> - 2026-10-28 · `npm test` · 83 passing · local (Node 25)
> - 2026-10-28 · CI · green on Node 22.19 and 24 · run `78031f4`
> - consensus replay · 87% confidence · local
> - dissent replay · 43/29 split · local
> - messy replay · refused, 3 chatters / 12 blocked · local
> - overlay · verified at 1920×1080 and 1280×720 · manual, screenshots `docs/overlay-consensus.png`, `docs/overlay-dissent.png`
> - live Twitch leg · **not verified** · needs credentials; `npm run doctor` is the gate and exits 0 only after a real chat message
>
> **Finish:** run `npm test` again, commit in logical chunks with conventional
> messages, and `git push`. If tests or the push fail, stop and report the exact
> output.
>
> **Acceptance:** `npm test` 83 passing; no `74 tests` string left in docs;
> `docs/VERIFICATION.md` clearly marks the live leg as unproven; CI green after
> the push.
