# Muse Listen

A separate Even glasses app, package `com.piebird.muselisten`. It consumes the
Muse Listen API; it does not modify or embed G2 OMAC. The hub implementation
and Muse relay scheduling belong to Half A.

## Build and configure

```sh
npm ci
npm run check
```

Copy `app.example.json` to the ignored `app.json` and replace its network
whitelist with your own hub address before packaging with `npm run pack`.
The phone page lets you configure the hub URL and bearer token. Include any
serving prefix, for example `https://your-hub.example/hud/`. Credentials stay
in this app's private browser-storage namespace and are never diagnostic text.
Do not commit a token, `.env.local`, or your private `app.json`.

Opening or configuring the app does not start recording. Select **Start** on
the phone or select on the glasses/remote to opt into each listening session.
Microphone access is requested only when starting. A visible **Listening**
indicator remains while recording; an unconfirmed microphone shutdown remains
visibly warned and prevents another start.

## Controls and display

- Left: running session timer and timestamped transcript, newest at the bottom.
- Right: timestamped Muse notes. A `>` marks the selected note.
- Up/down: previous/next note. From newest, down selects the first note.
- Selecting a note jumps the transcript to that note's `at_t`. Its own timestamp
  shows when the note arrived, on the same session clock.
- Two downs within 400 ms: return to newest. Space the presses farther apart to
  move through two notes. Double tap/back also returns to newest.
- Select: start/stop. Leaving or closing the app releases the microphone and
  asks the bound hub to stop; reopening never resumes recording automatically.

Phone input uses the existing `/api/input/wait` long-poll flow; glasses touch
uses the same action mapper. There is no always-on mode in v1.

Each session keeps the same hub connection. PCM uploads are 16 kHz mono signed
16-bit little-endian chunks, with a bounded queue. Unknown upload outcomes are
not retried automatically; lost audio is visibly reported. Polling merges
timestamped history without losing the selected note. Missing/failed replies
show plain reasons, not server or relay response bodies.

The renderer updates only a changed box, spaces SDK writes by at least 450 ms,
and rebuilds both boxes across session start/stop boundaries. It caps updates
at 950 characters and 950 UTF-8 bytes, filters unsupported glasses-font glyphs,
and reports failed or delayed frames. The model retains the original text.

## Fake-only verification

`npm test` uses fake hubs, microphones and SDK bridges. Startup tests apply the
SDK's own page validator. No test calls a real hub, transcription service or
Muse relay, and no test enables a real microphone.

On this macOS arm64 setup with Python 3 and Pillow installed, capture native
simulator evidence with:

```sh
node tests/simulator-check.mjs
```

The runner starts an isolated loopback fake hub and Vite fixture, copies the
installed `evenhub-simulator` into a temporary fixture bundle, and launches it
hidden/in the background. It drives only the simulator's HTTP automation API;
it never focuses or sends input to another application. It uses the actual SDK
renderer with an injected fake microphone. Only its own exact simulator process
and fixture servers are terminated during cleanup.

The scenario checks listening with transcript and two notes, phone down twice
selecting note two and jumping to its transcript time, touch navigation,
double-down returning to newest, a synthetic PCM upload, and stop releasing
the fake microphone. Native 576×288 framebuffer screenshots and the check
receipt are written to `output/simulator/`. The native PNG puts green text in
its alpha channel; `native-*.png` keeps the original bytes, and the readable
copies flatten transparency onto black without changing the framebuffer content.

These screenshots show synthetic fixture data. They are simulator evidence,
not physical-glasses, phone-button or live Muse acceptance. The complete
Half A/B join still needs the fake-relay snippet/queue test when both branches
are stitched together.
