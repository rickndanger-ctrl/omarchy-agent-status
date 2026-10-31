# Muse Listen in G2 OMAC

Open **Muse Listen** from Home or the glasses menu. This screen uses the existing Home hub address and token. There is no separate app installation or second SDK connection. The menu has ten items, including the existing Muse item.

On the glasses, hold to start. A tap while idle only displays “Hold to start listening.” Tap or hold while listening to stop. On the phone remote, Select deliberately toggles start/stop. Up/down selects a note and shows the transcript at its `at_t`; two downs within 400 ms return to the newest transcript. Double-tap/Back stops and leaves. Leaving through a menu, backgrounding or closing also stops; returning never restarts automatically.

The left box shows the microphone state, elapsed session clock and transcript. The right box shows MUSE notes with their arrival timestamps. Each box keeps the fixed-font and 950 UTF16/UTF8 budgets. Home's existing transport serializes SDK writes and updates only changed boxes.

One owner reserves audio before any asynchronous start. Listen refuses to start while another voice recording, transcription or unresolved microphone operation is active. While Listen owns the mic, audio is consumed exclusively by Listen; late audio is dropped during cleanup. An uncertain mic stop keeps ownership until off is confirmed. Every session retains its initial hub and token even if Home later adopts another hub.

Listen up/down navigation is handled at local gesture arrival, so Home's 450 ms render pacing does not stretch a 400 ms double-down into two independent downs. Start/stop, Back, holds and menus retain Home's shared input queue. This is a Listen-only navigation hook; the global queue and Muse input paths are unchanged.

## Verification

Run `npm test` three times and `npm run build` in `glasses/home-app`. Tests cover the controller, hub/chunks, transcript model, note anchors, physical tap privacy, remote select, leave cleanup, exclusive SDK PCM ownership and delayed-render double-down timing. Existing orch-hold tests retain the three-taps-send-nothing checks.

`glasses/test-listen-frozen.sh` checks anchored Home Muse spans against release `03f7bcf` and unchanged hub Muse spans against `56fe3b2`. `glasses/test-orch-hold-frozen.sh` checks the same release pins with exact additive Listen menu/paint hook exceptions. `node --test glasses/test-helpers/listen-frozen-mutations.test.mjs` proves the checks reject changed Muse code, new/deleted/symlink Muse paths, missing/ambiguous anchors and unreviewed hook changes.

`tests/listen-simulator-check.mjs` runs only from a disposable clone under `/tmp`. It uses the real Home/SDK renderer and an owned native simulator, synthetic PCM, fake Home inventory, fake ASR and a real guarded local hub. It writes Home, menu, listening, notes and selected-note PNGs; notes enter through real local `POST /listen/note`. It never enables a hardware microphone. Delete the clone after capturing evidence.

Physical glasses installation, actual microphone permission/capture, tactile controls and owner approval checks require a human and are deliberately not run by this task. Simulator and automated evidence do not certify those steps. No deployment is included.
