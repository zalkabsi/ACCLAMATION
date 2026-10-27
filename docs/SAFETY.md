# Safety and trust

Acclamation reads a live chat and speaks for it. That is only acceptable if the
crowd cannot be misquoted, dogpiled, or made to say something it did not say.
This document is the threat model and the mechanism for each rule. Every claim
here maps to a test.

## The four promises

1. **Nothing a person deleted can be quoted.**
2. **No links, personal data, commands, bots or blocked terms become receipts.**
3. **The model cannot invent a person, a quote or a number.**
4. **Agreement is measured; when there isn't any, Acclamation says so.**

---

## 1. Intake: what never enters the window

`src/chat/scrub.js` runs before a message is stored. A rejected message is
counted (with a reason) and displayed in the dashboard's **Held back** panel, so
the filter is visible rather than a black box.

| Rule | Example | Reason |
| --- | --- | --- |
| HTTP(S) / `www.` / known TLDs / `discord.gg` / `t.me` | `free bits at badlink.example.com` | `link` |
| Email | `mail me at viewer@example.com` | `pii_email` |
| Phone-like numbers | `call 555-123-4567` | `pii_phone` |
| Long digit strings | `id 123456789012` | `pii_digits` |
| Commands | `!drop`, `!lurk` | `command` |
| Known bot accounts (configurable) | Nightbot, StreamElements | `bot` |
| Channel blocked terms (word/phrase, case-insensitive) | `skill issue` | `blocked_term` |
| Empty / one-character / >480 chars | walls of text | `empty`, `wall` |
| Non-text message types | resub notices, highlighted messages | `non_text` |
| Duplicate of the same user's line within 60s | copy-paste spam | `duplicate` |
| More than 6 lines per user in the window | flooding | `flood` |

`ALLOW_LINKS=true` relaxes only the link rule. PII is never allowed.

## 2. Deletion and bans are tombstones

`channel.chat.message_delete` arrives in real time. The window removes the
message, records the id, and refuses to accept that id again even if the same
event is delivered twice. The model's prompt is built from the window *after*
scrubbing, so a deleted message cannot appear in a prompt, a cluster, a
representative or a receipt.

`ChatWindow.banUser()` removes every message from a user and rejects their
future messages; it is exposed for a `channel.ban` subscription (not wired yet —
see AGENTS.md). Helix delete of the subscription on shutdown keeps Twitch's
subscription list clean.

## 3. Grounding: the model picks ids, the server writes quotes

The prompt contains, per stance, up to eight `{message_id, user, text}` samples.
The answer contract only allows ids from that set:

```json
{
  "version": 1,
  "mode": "consensus",
  "stance": "…",
  "receipts": ["c07", "c08"]
}
```

Validation rejects:

- any id that was not in the supplied samples (`msg-invented`);
- a URL or control character in `stance` / `label` / `note`;
- unknown fields, wrong `version`, too-long text;
- a `mode` that disagrees with the measured mode;
- dissent answers without exactly two distinct voices, or with both voices
  citing the same receipts;
- a top-level `stance` in a dissent answer (no smuggling one voice as both).

On failure the session retries **once** with the validator's complaints appended,
then falls back to the local voice. Usernames and quotes are resolved from the
window by id — the model's own text never becomes what the audience sees next to
a name.

Prompt-injection guard: chat samples are labelled as untrusted data, and the
system prompt instructs the model to treat any instructions inside them as
content to discuss, not commands to follow. A test asserts the guard is present
in the prompt.

## 4. Measured, not asserted

`measureConsensus()` computes the leading stance's share of **unique chatters**
(not messages), shrinks it toward 50% for small samples, and adds a small
decisiveness term. `confidence` is not part of the model contract; a model that
returns one is rejected as an unknown field. The session attaches the measured
number to the answer and exposes the basis (chatters, messages, top share,
runner-up share, reliability) in the dashboard and API.

Modes:

| Mode | When | Behaviour |
| --- | --- | --- |
| `consensus` | one stance ≥40% and clearly ahead | one voice, 1–5 receipts, measured confidence |
| `dissent` | runner-up ≥25%, leader <62%, ratio ≤2.8 | two voices, two receipt sets, split shares |
| `unclear` | scattered (<40% leader) or >50% emotes | refusal text; no invented agreement |
| `insufficient` | fewer than `MIN_CHATTERS` (default 4) | refusal; **no model call is made** |

The `insufficient` path is deliberate: a three-person room is not a crowd, and
speaking for it would be the exact failure this product is supposed to avoid.

## 5. Data handling

- The Twitch token lives in `.tokens.json` (mode 600, gitignored) or an
  environment variable. It is never sent to the browser: `publicConfig()` is the
  only config shape the API exposes.
- Chat text goes to the model only when the streamer triggers an answer, and
  only as the bounded sample payload (max 5 stances × 8 messages, plus ids).
  There is no always-on model stream.
- The dashboard and API bind to `127.0.0.1` by default. Do not expose the server
  publicly without adding authentication.
- SQLite stores pinned lore, calls and the scoreboard locally under `.data/`.
- Acclamation never posts to chat. Audio is produced by the overlay page that
  OBS captures, which keeps it outside chatbot review entirely.

## 6. Failure behaviour

| Failure | What happens |
| --- | --- |
| Model timeout / 5xx / invalid JSON twice | local voice answers from the same measured clusters (still grounded) |
| Model invents an id | rejected, one repair, then local voice |
| Too few chatters | refusal; no model call, no receipts |
| Twitch socket dies | reconnect with jittered backoff; resubscribe on a new session |
| Keepalive missed | watchdog closes and reconnects before the demo notices |
| Deleted message arrives mid-answer | the window is scrubbed on arrival; an answer already in flight can only cite ids that were valid when the window snapshot was taken, and the next trigger never sees it |

## 7. Not covered (and what to do about it)

- **No automated moderation of slurs or harassment.** Blocked terms are a
  channel setting (`BLOCKED_TERMS`), not a model judgement. For a public demo,
  set the channel's chat filters and pre-block known-bad terms.
- **No `channel.ban` subscription.** A timeout only scrubs messages when a ban
  event is delivered; today the streamer can call the session's `banUser`, but
  the overlay path is delete-driven.
- **No age-gating or PII redaction of chat display** beyond intake filtering;
  screenshots for the submission use seeded chat, not real viewers.
- **Model hosting.** If `LLM_BASE_URL` points at a third party, chat samples
  leave the machine per that provider's terms. The local voice keeps everything
  local.
