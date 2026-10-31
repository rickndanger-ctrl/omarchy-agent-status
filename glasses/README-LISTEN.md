# Muse Listen: the live page

Start a Listen session on the glasses. On the Mac running the configured hub,
give Muse this one sentence:

> Keep reading http://127.0.0.1:5182/listen/live.html; whenever something useful comes up, type a short note in the note box and press Send.

The page shows the transcript with local wall-clock and session timestamps.
It refreshes every two seconds while keeping a note draft intact. The note box
has an optional **about** time (`mm:ss`); leaving it blank links the note to the
newest transcript line. Press **Send** to add it. Recent notes appear below the
box and become available immediately through the Listen API.

Use `127.0.0.1` on that Mac, not a phone, tailnet address or proxy. No hub token
is needed. Remote requests are refused even with a token. The plain-text page
is `http://127.0.0.1:5182/listen/live.txt`.

Default `notesFrom: "page"` sends Muse no automatic questions and makes no
automatic relay calls. Muse reads the page and uses its note box. Explicit
`"chat"` enables the earlier rolling relay path; `"both"` enables both sources.
Chat-only mode does not accept notes from the page.

Stop listening when finished. The page never starts a microphone or a session.
Audio and transcript data remain in memory; transcript text is never logged.

See [hub configuration and API details](../docs/LISTEN-HUB.md).
