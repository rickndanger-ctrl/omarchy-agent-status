# Muse Listen: hub half A

Muse Listen is separate from G2 OMAC. Its app belongs in `glasses/listen-app/`
with package id `com.piebird.muselisten`; half B owns that app. This half adds
the authenticated `/api/listen` API on a hub. It does not change `home-app/`,
deploy a hub, or enable an always-on microphone.

Every session starts only after an explicit `POST /api/listen/start`. The client
owns the microphone and **must call stop on app close/backgrounding**, as well as
on the owner's Stop action. A normal HTTP disconnect is not an app-close signal.
The hub also stops the session after 30 minutes without recognized speech;
silence, polling and receipt of empty audio do not extend that deadline.

## API

All calls use the hub's existing Bearer authentication. These endpoints exist
only in hub mode. No transcript, audio or note is written to disk.

| Request | Response |
| --- | --- |
| `POST /api/listen/start` with `{ "backend": "muse" }` (backend optional) | `{ id, startedAt }` |
| `POST /api/listen/chunk?id=…&seq=…` with raw PCM16, 16 kHz mono | `{ ok, lines: [{ t, text }] }` |
| `POST /api/listen/stop` with `{ "id": "…" }` | `{ ok }` |
| `GET /api/listen?id=…&since=…` | `{ id, state, startedAt, now_t, lines, notes, muse }` |

The client numbers chunks from zero. The chunk request waits for that chunk's
ordered transcription; Muse runs separately in the background. Retrying an
already accepted sequence does not transcribe or send it twice. Audio and
pending sequences are bounded; a missing sequence is eventually skipped rather
than blocking the session forever. A stopped session accepts no new chunks or
Muse work. On stop/close, turn the microphone off, send the final PCM chunk and
await its acknowledgement **before** posting stop. A concurrent stop discards
unfinished transcription. Starting again creates a new session id.

`startedAt` is epoch milliseconds. All other times are milliseconds on that
session's elapsed clock. `lines[].t` estimates the start of its PCM chunk from
receipt time minus audio duration, before transcription begins. The request
format has no capture timestamp or word alignment, so this is a chunk-level
estimate, not a word-accurate speech timestamp. Network delay can affect it.
Ordering and the elapsed clock stay monotonic. Line and note timestamps each
break ties by at least one millisecond, so repeated identical speech/notes are
distinct records; `now_t` includes that deterministic tie-break. A note's `at_t` is the end of the
exact transcript snippet it discusses; its `t` is when the note arrived.

`since` is an **inclusive publication cutoff**, using the previous response's
`now_t` as the next cutoff. A newly transcribed line can have `t < since` because
its audio predates transcription completion; it is still returned when it was
published after the cutoff. Equal-clock records can repeat. Merge/deduplicate
lines and notes by their timestamp/text tuples, or omit `since` to obtain the
bounded current snapshot. Do not use a note's `at_t` as a publication cursor.

## Snippets and the shared Muse queue

The first snippet becomes eligible after at least 25 new words. Later snippets
wait at least 45 seconds after the previous request finishes. This conservative
gap also applies after a long wait behind G2, so queueing cannot bunch actual
Listen submissions together. The last two sent snippets are
included as time-labelled context. The prompt requests one useful note of at
most 25 words, or exactly `—` when there is nothing useful to add.

Only a finished reply can become a note. It passes through the existing
`muse-clean.mjs`, then the note limits (25 words and 300 characters). Empty
answers, `—`, and the cleaner's no-text placeholder are dropped. Public errors
and Muse state reasons are fixed plain messages, never raw relay error text.
The prompt bounds its two context snippets and new snippet to fit the shared
queue's 16,000-character limit.

Both G2 OMAC and Listen enter the same queue. A question owns the slot from
submission through a terminal relay reply, including while an active Listen
session is stopped. Queued G2 asks take priority over queued Listen snippets;
an already running question is not preempted. G2 receives a quick queued job id
and continues using its existing reply-polling API, so a waiting question does
not outlast the app's eight-second submission timeout.

An uncertain relay submission is not retried on another Muse: it might already
have been accepted. The slot stays held until completion can be established;
an unknown-id submission returns plain unavailable results to waiting/new
clients and requires operator reconciliation before a restart can
resume sending. Queue ownership is in this hub process, not a durable lock
across multiple hubs or restarts. Confirm the relay is idle before restarting
after an uncertain submission. A local
timeout or client cancellation is not proof that Muse stopped. Stopping Listen
cancels unsent snippets and suppresses late results without freeing a still
active relay slot.

Optional hub configuration (defaults shown):

```json
{
  "listen": {
    "snippetMs": 45000,
    "minWords": 25,
    "idleMs": 1800000
  }
}
```

## Verification boundary

Tests use fake transcription and a fake Muse relay on explicit loopback ports,
private temporary home/config directories, and blocked external network/child
commands. No test may contact the real Muse or relay. The API integration test
is `bash glasses/test-hub-listen.sh`; the session and queue tests use Node's
built-in test runner. Half B's remote navigation, microphone and rendering are
separate join/device checks; this half makes no real glasses or deployed-hub
claim.
