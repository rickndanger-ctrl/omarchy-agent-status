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

## Best-effort Listen snippets

The first snippet becomes eligible after at least 25 new words. Later snippets
wait at least 45 seconds after the previous request finishes. This conservative
gap also applies after skipped or failed attempts, so retries cannot bunch
Listen submissions together. The last two snippets are
included as time-labelled context. The prompt requests one useful note of at
most 25 words, or exactly `—` when there is nothing useful to add.

Only a finished reply can become a note. It passes through the existing
`muse-clean.mjs`, then the note limits (25 words and 300 characters). Empty
answers, `—`, and the cleaner's no-text placeholder are dropped. Public errors
and Muse state reasons are fixed plain messages, never raw relay error text.
The prompt bounds its two context snippets and new snippet to fit the
16,000-character input limit.

G2 OMAC's `askMuse`, relay helpers and existing `/api/muse*` paths are restored
byte-for-byte from `56fe3b2`. Listen does not wrap, queue, alias or intercept any
G2 request. There is no shared G2/Listen queue and no virtual G2 job id.

Listen's own service admits at most one snippet at a time. Only the last
configured Muse receives Listen questions. It sends only after explicit relay
`/selftest` reports `composer: true` and `busy: false`, and its read-only G2
gate permits it. Other relays are checked before and after the target's health
probe. Missing or ambiguous readiness is not idle. Busy attempts return at once
rather than waiting or blocking G2. Proven unsent speech is retained/merged for
the next cadence attempt; it is not submitted repeatedly in a busy loop.

The hub gate reads existing handoff flags and G2 client diagnostics without
changing them. Direct API callers emit no client diagnostics, so the other
relays' busy flags provide an additional veto. These observations are
best-effort snapshots, not an atomic cross-client lock. The laptop join test
keeps Listen on the last Muse and G2 on the first; its one-Muse overlap is an
explicit known risk. G2's original admission behavior remains unchanged.

Every health/send/poll request and the complete attempt have hard time limits.
At most one POST is attempted per snippet. A failed or uncertain POST is dropped,
never retried on the same or another Muse. Cancellation suppresses late notes;
unknown acceptance does not poison a shared queue or stall G2. A later, distinct
snippet must pass readiness again. Note output remains capped at 300 characters.
Only a proven pre-send busy/skipped result permits retaining speech; errors and
timeouts do not restore a possibly submitted snippet.

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
