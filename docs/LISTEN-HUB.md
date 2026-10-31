# Muse Listen: hub half A

Muse Listen is separate from G2 OMAC. Its glasses app is `glasses/listen-app/`,
package `com.piebird.muselisten`. This hub provides the authenticated session API
and a separate, unauthenticated **direct-loopback-only** transcript page.
Owner instructions: [README-LISTEN.md](../glasses/README-LISTEN.md).

A session starts only after explicit `POST /api/listen/start`. The client owns
the microphone and must call stop on app close/backgrounding and on Stop.
A normal HTTP disconnect is not an app-close signal. The hub stops after
30 minutes without recognized speech. Reading, posting notes, polling, silence
and empty audio do not extend that speech deadline.

## Live page and notes

These routes exist only on a hub and require a direct connection from
`127.0.0.1` (including an IPv4-mapped socket), with exactly one raw Host
header spelling `127.0.0.1:<PORT>` or `localhost:<PORT>` (ASCII case-insensitive
for localhost only). The explicit port must match the accepting socket.
Abbreviated/octal IPs, IPv6 Hosts, missing ports and duplicate Host/Origin
headers are refused before any session is read.
Other addresses, forwarded/proxied requests and foreign browser origins are
refused with a generic 404 even with a valid Bearer token. This includes Via
(even empty or repeated), Forwarded, every X-Forwarded-* and Tailscale-* header. They do not use the API's
permissive CORS policy. No transcript text is logged or written to disk.

| Request | Result |
| --- | --- |
| `GET /listen/live.txt` | Live session header, then `[YYYY-MM-DD HH:MM:SS] [mm:ss] text` per transcript line, newest last |
| `GET /listen/live.html` | The same transcript, note form and recent notes; refreshes every two seconds without replacing the draft |
| `POST /listen/note`, JSON `{ "text": "…", "about": "mm:ss" }` | Stores a cleaned note; JSON receipt |
| `POST /listen/note`, form fields `note` and optional `about` | Stores a note and returns to the page |

Before a session starts, both pages return 200 with "no Listen session on this
hub"; a note submission then returns 409. Plain text also has a restrictive
Content-Security-Policy.

No token is needed for a direct-loopback form or JSON request. The complete
request body is limited to 4096 UTF-8 bytes; larger bodies return 413 and store
nothing. The form/JSON session ID is optional: omission targets the current
session, while a different supplied ID returns 409 and stores nothing.
Browser-origin checks protect the form without requiring another secret. A hidden session ID
binds a form draft to its session. Stopped or stale submissions fail plainly.

Omitted `about` uses the newest transcript line's `t` (or zero before speech).
An explicit anchor must be a valid nonnegative session-relative timestamp.
It is preserved even if that transcript time has not arrived at the hub yet;
it does not advance the arrival/session clock. Manual notes
pass through `muse-clean.mjs` and are capped at 300 characters, without a separate
25-word limit. Their `t` is arrival time; `at_t` is the transcript anchor.
They appear immediately in `GET /api/listen`, for the glasses' next poll.

## Authenticated session API

All `/api/listen*` calls retain hub Bearer authentication and exist only in hub
mode. No audio, transcript or note is persisted.

| Request | Response |
| --- | --- |
| `POST /api/listen/start` with optional `{ "backend": "muse", "notesFrom": "page" }` | `{ id, startedAt, notesFrom }` |
| `POST /api/listen/chunk?id=…&seq=…`, raw PCM16, 16 kHz mono | `{ ok, lines: [{ t, text }] }` |
| `POST /api/listen/stop` with `{ "id": "…" }` | `{ ok }` |
| `GET /api/listen?id=…&since=…` | `{ id, state, startedAt, now_t, lines, notes, muse, notesFrom }` |

Sequences start at zero. Each chunk waits for ordered transcription; accepted
sequence retries do not repeat it. Pending audio and sequences are bounded,
and missing sequences have a bounded gap wait. The client turns off its mic,
sends/awaits the last chunk, then posts stop. Concurrent stop discards unfinished
transcription. Restart creates a new ID.

`startedAt` is epoch milliseconds. Other times are elapsed milliseconds.
Transcript `t` is a coarse PCM-receipt/duration estimate, not word alignment.
Local wall-clock labels use `startedAt + t` in the hub Mac's time zone. Session
labels become `h:mm:ss` past an hour. Monotonic tie-breaking keeps repeated
identical lines/notes distinct, and `now_t` includes those ties.

`since` is an inclusive publication cutoff. Late transcription may have spoken
`t < since` but still be returned because publication happened later. Deduplicate
by timestamp/text tuples or omit `since` for the bounded snapshot. A note's
`at_t` is not a publication cursor.

## Note-source modes

Defaults:

```json
{
  "listen": {
    "notesFrom": "page",
    "g2PauseMs": 60000,
    "snippetMs": 45000,
    "minWords": 25,
    "idleMs": 1800000
  }
}
```

- `page`: manual page notes only; zero automatic relay health, ask or reply
  calls, even while speech arrives. Invalid modes fall back to this default.
- `chat`: explicit opt-in to rolling relay notes; page submissions are disabled.
- `both`: manual page notes plus the rolling relay path.

The start request can override `notesFrom` for that session with `page`, `chat`
or `both`; another explicit value returns 400. Omission uses the hub setting.
The selected value is returned by the start response and every session snapshot.

`g2PauseMs` sets the chat path's observed-G2-request quiet period. Its default is
60000 ms; only positive finite numbers are accepted as configuration values,
and invalid values (including zero) use that default.

Chat/both retains the earlier fixes: one Listen attempt at a time, only the last
configured Muse targeted, and only that target must be idle/ready. Other relays
being down is not a veto. Observed G2 asks, reply/latest polls and transcription
requests block new Listen POSTs for `g2PauseMs` (60 seconds by default) after
the latest activity.
Diagnostic busy assertions expire after 150 seconds without new evidence.
Proven unsent busy speech can be retained for a later cadence; uncertain/error/
timeout snippets are dropped, including future context.

Relay snippets require at least 25 new words, with at least 45 seconds after the
previous attempt finishes by default. Only confirmed completed snippets enter
the two-snippet context. The prompt requests one useful note of at most 25 words
or `—`; dash, empty and no-text replies are dropped. Shared cleaning and a
300-character cap apply. Requests and whole attempts have hard deadlines;
possibly admitted POSTs are never retried automatically.

G2's routes, helpers and client stay frozen. Its previously authorized `askMuse`
condition permits FIFO admission behind a POSTed unfinished Listen job on that
Muse, only until Listen's hard deadline. The page adds no further G2 changes.
It does not repair the separately reported frozen fallback race.

## Verification

Tests use private temporary homes, fake transcription/relays, explicit loopback
ports and deny-by-default network/child-process guards. They never contact real
Muse, relays or a deployed hub.

```sh
node --test glasses/test-listen.mjs glasses/muse-queue.test.mjs glasses/test-listen-g2.mjs glasses/listen-page.test.mjs
bash glasses/test-hub-listen-page.sh
bash glasses/test-hub-listen.sh
bash glasses/test-hub-muse.sh
bash glasses/test-listen-frozen.sh
bash glasses/test-listen-join.sh
```

The supplied frozen script needs Python 3.12+ for its f-string syntax. Legacy
relay fixtures explicitly select `notesFrom: "chat"`; they do not change the
production default. Half B's remote controls, mic and physical glasses rendering
remain separate integration/device checks.
