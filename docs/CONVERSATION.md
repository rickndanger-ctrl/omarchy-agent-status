# Conversation tile: app ↔ hub ↔ node contract

A conversation assistant in a tile: the owner starts it, the glasses listen, and the tile shows two or three
short hints as the talk goes on. On stop the tile shows a summary with action items, and the hub keeps that
summary. This is our own design; it is not based on any other product. Contract fixed 2026-10-29.

## Rules

- It listens only after a Start: a tap in the tile. It is never always-on. (There is no "Listen" item in the glasses long-press menu: the Even SDK allows 10 items, and an 11th makes the whole app fail to start.)
- While listening, the tile header shows `● Listening mm:ss`. It stops after 30 minutes, when the owner stops it,
  or when the app leaves the foreground. Each of these makes a summary.
- Only one session runs at a time, and the microphone is shared: while listening, the voice-reply microphone
  says "Stop listening first", and the other way round.
- Audio and text go only to Groq (transcription) and to the one AI backend the owner chose. Muse gets
  nothing, except through the single "Send summary to Muse" action described below.
- The transcript and summaries stay on the owner's hub and are never committed. Tests use fake
  microphone, transcriber, backends and Muse.

## App → hub (Bearer token, like every other /api/ call)

    POST /api/conversation/start  {backend: "local"|"claude"|"codex"}
                                  → 200 {id, startedAt}  | 409 {error:"already listening"}
    POST /api/conversation/chunk?id=<id>&seq=<n>     seq counts from 0 in send order; body: raw PCM, 16 kHz s16le mono, about 9 s (~288 KB),
                                                     max 1 MB, application/octet-stream
                                  → 200 {ok:true} at once; transcription and hints run in the background
                                  → 404 unknown/finished id · 410 over 31 min · 413 too large
    POST /api/conversation/stop   {id}  → 200 {ok:true}; the summary fills in on later GETs
    GET  /api/conversation        → Conversation (the current session, or the last finished one, or {state:"idle"})

    Conversation = {
      id, state: "listening" | "summarizing" | "done" | "error" | "idle",
      backend, startedAt, stoppedAt?,
      hints: string[],          the latest 2–3 lines, each ≤ 40 characters
      summary?: string[],       up to 5 lines, once done
      actions?: string[],       action items, once done (may be empty)
      fallback?: string,        set when the last hint/summary came from another helper because the chosen one failed
      error?: string,           one plain line ("The local model is not running", "Transcription failed")
      chunks: number, words: number,
      skipped: number           chunks that could not be transcribed (the tile says "N pieces missed")
    }

The app polls GET /api/conversation about every 2 s while a session is listening or summarizing.

## Hub behaviour

- Each chunk: transcribe it with the existing Groq path (`transcribe(pcm)`), append it to the session's transcript,
  then ask the backend for hints with the rolling transcript (last ~2 minutes). There is never more than one
  hint request in flight; a chunk that arrives while one is running just waits for the next one.
  Chunks are transcribed in seq order; a seq below the next expected one (a late chunk after a gap was given up)
  is dropped. A failed chunk is logged, counted in `skipped`, and the session goes on. If nothing at all came out of
  the talk, the session ends in `error` instead of an empty summary: "Nothing could be transcribed" when a chunk failed, or "Nothing was heard" when there were no failed chunks (silence, or no chunks at all). A good hint or summary clears an earlier `error`.
- Hint prompt: return 2–3 lines, each under 40 characters, chosen from: a key point, a question worth asking,
  a useful fact. Nothing else.
- The app stops at 30 minutes and sends its last chunk; the hub only enforces a 31-minute guard (its own timer
  and the 410), so the final chunk still counts.
- Stop (or the 31-minute guard): summarize the whole transcript into ≤ 5 lines plus action items, then write
  `~/.config/agent-glasses/conversations/YYYY-MM-DD-HHMM.md` (directory 0700, file 0600) with the summary,
  the action items and the transcript. Only the newest session stays in memory.
- Diagnostics (/api/diag): `conv.start`, `conv.chunk` (seq, ms, words), `conv.hint` (ms), `conv.stop`,
  `conv.error`. Counts and timings only; no transcript text.

## Backends (the owner's choice in Settings; default "claude")

Helpers: each CLI is found once, when the hub or node starts: `HUD_CLAUDE_BIN` / `HUD_CODEX_BIN` if set (a path
that does not exist means "not set up", with no search), else PATH, else `~/.local/bin`, `/opt/homebrew/bin` and
`~/.local/share/mise/shims` (a LaunchAgent's PATH often lacks them). The path found is logged at start. A helper
that is not found is "not set up on this hub", and the local model that does not answer is "isn't running on this
hub". `GET /api/diag` adds `helpers: {claude: {path|null}, codex: {path|null}, local: {reachable}}` (no tokens).

Fallback: the chosen helper is tried first. When it is not set up, fails or times out (hints: 20 s, summary: 60 s),
the hub goes on down the chain Claude → Codex → local, skipping any that is not set up or not running, and the first
one that answers does that request. The tile then shows the line `(<who> answered: <why the chosen one did not>)`,
for example `(Codex answered: Claude didn't answer)` or `(local model answered: Claude isn't set up on this hub)`;
Conversation gets `fallback?: string` for it. Each request starts again from the chosen helper, so the session keeps
trying it. If nothing answers, the error is the chosen helper's own line, for example `Claude isn't set up on this
hub`. The local model is the last step, so a Local choice has no fallback.

The hub sends each think request to the node named for that backend in hub.json, and that node runs it on its
own machine:

    hub.json  "conversation": {"local": "lap", "claude": "lap", "codex": "Mini 1"}     node names; "self" = this hub

    POST /api/think  {backend, system, prompt, timeoutSec}     (on a node, Bearer that node's token)
                                  → 200 {text, ms} | 4xx/5xx {error}

- local: OpenAI-compatible chat on `http://127.0.0.1:18081/v1` on that node (Ornith 35B on the laptop); `HUD_LOCAL_LLM_URL` overrides it.
  It is reached only on loopback by the node itself and is never exposed.
- claude: `$HUD_CLAUDE_BIN` or the found `claude -p --tools "" --strict-mcp-config --no-session-persistence` in a fresh temp folder.
- codex: `$HUD_CODEX_BIN` or the found `codex exec --skip-git-repo-check --sandbox read-only --ephemeral --ignore-user-config -C <temp> -` with the prompt on stdin. `--ignore-user-config` is in `codex exec --help` for codex-cli 0.162.0: "Do not load `$CODEX_HOME/config.toml`; auth still uses `CODEX_HOME`".

The runners are the public Ask tile's backend code (public/g2-tiles/hub/ask.mjs, now g2-omac), moved into
`glasses/think.mjs` so hud-server.mjs only imports it. Test hooks are environment variables:
`HUD_THINK_FAKE=1` (canned replies), `HUD_TRANSCRIBE_URL` (a fake Whisper server), `HUD_LOCAL_LLM_URL`.

## Tile (app)

Layout id: `conversation`. Header: `Conversation` when idle, `● Listening 12:04` while listening,
`Summarizing…`, `Summary · 14:32` when done.
- Idle: tap → Start (with the backend from Settings).
- Listening: shows the hints; tap → Stop. The app sends ~9 s of PCM per chunk, in order, one at a time.
- Done: shows the summary and action items (scrollable). Tap → actions: Start new · Send summary to Muse.

Settings (phone page): "Conversation AI": Claude (default) · Local model (free) · ChatGPT (Codex).

## Send summary to Muse (the owner asked for this explicitly)

On a finished summary only. One tap dispatches Home's existing `{kind: 'askMuse', text}` action, unchanged
(POST /api/muse/ask, then the same /api/muse/reply polling), so Muse's answer shows in the Muse tile like any
other ask. The text is `Summary of a conversation (<YYYY-MM-DD HH:MM>):` + the summary + the action items,
capped at 1500 characters. It is never automatic, never available while listening, and only once per summary:
after the tap the item greys out ("Sent to Muse"), remembered per summary id. No Muse endpoint, relay, timer
or polling changes. Tests use a fake Muse. The Muse-related diff goes to the owner before merging.
