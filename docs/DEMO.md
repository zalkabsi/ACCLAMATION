# Three-minute demo

The video is capped at 3:00 and must show the project **working on Twitch** and
**how Codex was used**. Record at 1080p; use the overlay at
`http://127.0.0.1:8787/overlay` as an OBS browser source, 1920×1080, with
"Shutdown source when not visible" off so audio keeps playing.

## Pre-flight (10 minutes before)

```bash
npm test                         # 83 green
npm run doctor                   # must print a real chat message; otherwise use the replay fallback
npm start                        # dashboard + overlay up
```

On 2026-10-29, `npm run doctor -- --wait=300` received a real Twitch chat
event and exited 0. One earlier attempt missed a keepalive, after which the
doctor did not recreate its subscriptions on reconnect. In a separate test,
the live app ingested a real chat event and emitted an insufficient-chat answer
on the overlay event stream. After a forced pause, the app recreated its Twitch
subscriptions but still displayed a `reconnecting` status. Run the pre-flight
again before recording; the live overlay and browser audio still need their own
runtime check. See [verification evidence](VERIFICATION.md).

Redacted output from that run:

```text
DOCTOR_SUCCESS: REAL CHAT ARRIVED.
DOCTOR_EXIT: 0
```

- OBS: browser source → overlay URL, width 1920, height 1080, "Control audio via
  OBS" on.
- Dashboard on a second monitor or a window capture.
- Warm the chat: post one question in Discord so people are watching.
- Have the replay command ready in a second terminal:
  `npm run replay -- --fixture replay/fixtures/dissent.jsonl --serve`
  If Twitch chat is dead at record time, restart on the replay server and say
  "this is the replay harness" — the product is identical because it is the same
  code path. Do not present replay as live.

## Shot list

| Time | Shot | Action | VO line |
| --- | --- | --- | --- |
| 0:00 | Gameplay clean | No overlay | "Every stream has a chat. None of them have a voice." |
| 0:07 | Overlay appears, cloud drifting | Show OBS | "This is Acclamation. Every message you're about to see becomes a glyph." |
| 0:15 | Dashboard | Type "Chat, what do you actually think of this run?" → **Ask chat** | "One question. No per-message bot — a single character." |
| 0:18 | Overlay | Glyphs converge into a face; stance lands; receipts fly in | "It measures the room, then answers in its voice — and shows the receipts." |
| 0:28 | Zoom receipts | Highlight `@mochirose` and the confidence chip | "That 87% isn't the model guessing. It's the share of chatters behind that stance." |
| 0:38 | Dashboard | Click **Dissent** | "But what if the room is split? Ask again, harder." |
| 0:42 | Overlay | Face fractures into two, two voices, cyan vs orange | "Two voices. Arguing. From the same chat, at the same time." |
| 0:55 | Reaction | Let the argument land, show split shares | "Chat is not one thing. Now you can hear both halves of it." |
| 1:05 | Real raid (or replay raid) | Raid notification in chat | "A raid just hit — 81 people. The face reacts before the model even speaks." |
| 1:15 | Dashboard | Show **Held back** panel: deleted, links, bots | "Everything unsafe is scrubbed before the model sees it. Deleted messages never become receipts." |
| 1:25 | Dashboard | Pin lore: "chat still calls the 20-choke run"; trigger again | "It remembers the channel. Tomorrow it still knows what chat called." |
| 1:35 | Scoreboard | Click **Chat wins** | "A running record. The streamer finally has a rival: their own audience." |
| 1:45 | Codex | Show `AGENTS.md`, `npm test` running, one Codex thread | "Built with Codex: the EventSub client, a fake EventSub server so we could build offline, the overlay, and 83 tests." |
| 2:10 | Repo | Show README + repo URL | "Zero dependencies. `npm test`, `npm run replay`, `npm start` — and the doctor proves the live leg before you trust it." |
| 2:25 | Cold close | Overlay idle | "Your chat has a word. Now it has a voice." |

## Answering the obvious judge questions

**"Is this just an LLM summarising chat?"**
No. The model chooses wording and ids; the stance share, the split decision and
the confidence are computed from the window. The model is not allowed to return
a confidence at all.

**"What if chat is toxic?"**
Intake drops links, PII, commands, bots and blocked terms before the model sees
anything; the overlay never quotes a deleted message; and the model is told to
speak as the crowd without slurs. The dashboard shows exactly what was held back.

**"Why not post in chat?"**
Chatbot reviews are a policy risk and add nothing to the experience. Audio from
the overlay plus OBS is review-free and works on any channel.

**"What's new here?"**
The direction is inverted: not AI-to-chat, but chat-to-one-voice. Split mode is
the visible proof — it is a format, not a widget.

## Fallbacks

| Problem | Fallback |
| --- | --- |
| Chat dead at record time | `npm run replay -- --serve` with the dissent fixture; label it as the replay harness |
| Model key missing or slow | local voice answers instantly; same measured numbers, simpler wording |
| Browser audio blocked | click once inside the OBS source (Interact), or set `?mute=1` and rely on captions |
| Live token expires mid-record | restart `npm start`; doctor/startup refresh handles it |
| Twitch API outage | replay; the demo is still real code |

## Recording notes

- Record the dashboard *and* overlay in one scene so a cut never hides the cause
  and effect.
- Do not cut between "Ask" and the face forming — the sub-second reaction is the
  point.
- Keep the Codex segment to 20–25 seconds; one thread, one test run, one config
  file is enough.
- End on the repo and the tagline. No slides.
