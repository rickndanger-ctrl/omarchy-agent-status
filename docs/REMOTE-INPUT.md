# Phone remote: hub ↔ glasses ↔ phone contract

A phone app (built separately) acts as a remote for Home on the glasses: its four buttons arrive on the
glasses as if they were touchpad gestures. Contract fixed 2026-10-28; the iPhone app is built against it.

## Phone → hub

    POST /api/input  {"input": "up" | "down" | "select" | "back" | "settings"}     Bearer <the hub's shared token>

    200 {"ok": true,  "delivered": true,  "seq": 42}          a glasses app is listening; it gets it within ~300 ms
    200 {"ok": true,  "delivered": false, "reason": "no glasses listening on this hub"}
                                                              nothing waiting here: Home is not in front, or the
                                                              glasses use another hub (try the next hub)
    400 {"ok": false, "error": "input must be up, down, select, back or settings"}
    401 {"error": "bad token"}
    429 {"ok": false, "error": "too fast"}                    more than 10 inputs in the last second (shared by all
                                                              phones); the input is dropped, not queued

"Listening" means a glasses app has an open wait (below) or closed one less than 3 s ago.

## Glasses → hub (live channel: long-poll)

    GET /api/input/wait?after=<seq>        Bearer <token>

Answers as soon as there is an input with a number above `after`, or after 25 s with an empty list:

    200 {"seq": 42, "inputs": [{"seq": 42, "input": "select", "at": 1793250000123}]}

- The hub keeps only inputs from the last 2 s; older ones are never delivered (no replay of stale presses).
- `after` missing or 0 means "from now": the first wait only returns inputs that arrive after it opened.
- A long-poll, not Server-Sent Events, because the glasses' web view can then keep sending the
  Authorization header like every other call.

The app keeps one wait open only while Home is in front (`foreground`), opens the next one right after each
answer, and backs off (1, 2, 5 s) on errors. When it is in the background it holds no wait, so the hub says
"no glasses listening". The 2 s poll of /api/home is unchanged and still the fallback for everything else.

Each input goes through the app's own `handle(input)`, exactly as a touchpad gesture would, so every screen,
tile and pop-up behaves the same. An input that arrives while Home is not in front is ignored.

## Diagnostics

Every POST /api/input is recorded in /api/diag as `remote.input` with the input, delivered or not, or
`remote.limited` when rate-limited. The app records `remote.applied` with the screen it landed on.
Names and inputs only; no other content.

## Scope

Home's own hub (glasses/hud-server.mjs) and app (glasses/home-app). Nothing here touches Muse: no Muse
endpoint, call or timer changes.
