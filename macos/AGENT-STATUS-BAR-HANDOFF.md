# Agent Status Bar → OMAC: detailed handoff

Written 2026-10-21 by Claude (Fable 5.1) on Rick's Dell laptop (omarchy-3).
For: Codex (or any agent) working on **OMAC** on Mac mini 1.
Goal: **OMAC's agent lights should look and behave exactly like the Agent Status
Bar on Rick's Omarchy laptop.** This folder contains that bar, already ported
to Swift, built and tested on Mac mini 1. Your job is to put it into OMAC.

Rick's words: "Inside Omak it has the same Agent Status Bar ... their Agent
Status Bar isn't as good." The laptop version is the reference. Match it.

---

## 1. Where everything is

| What | Where |
|---|---|
| Original Linux widget (source of truth) | GitHub `rickndanger-ctrl/omarchy-agent-status`, root files `BarWidget.qml`, `status.py`, `hermes_plugin.py`, `setup_integrations.py` |
| Swift port (this folder) | same repo, `macos/` (commit `6ced0cd` and later) |
| Copy on Mac mini 1, already built | `~/Documents/Codex/2026-09-22/omac-native-rebuild/outputs/agent-status-laptop-port/` |
| Copy in the Mac bridge | `~/MacBridge/agent-status-bar/` (this document sits next to it) |
| OMAC source on Mac mini 1 | `~/Documents/Codex/2026-09-22/omac-native-rebuild/outputs/OmacNative/` |
| OMAC's current agent lights | `Sources/OmacCore/AgentPageStatus.swift`, `Sources/OmacApp/AgentInboxMenu.swift`, `AgentStatusChipsView.swift`, `AgentSoundsMenu.swift`, `AgentStatusWatcher.swift`, docs `Docs/AGENT-STATUS.md`, `Docs/AGENT-HOOKS.md` |

Verified on Mac mini 1 (Apple Swift 6.4, macOS 27): `swift build` clean,
`swift test` 13/13 passed, `agent-status poll` showed Codex as **working** read
live from its own session logs, and the demo menu-bar app launched and ran.

---

## 2. What the bar is (the behaviour to reproduce)

### 2.1 One badge per agent

Each visible agent gets a compact badge in the bar:

```
[icon] ● 3      [icon] ✓      Herdr ○
```

- **Icon**: 17 × 17 pt, the agent's app icon. If no icon can be found the
  agent's **name** is drawn instead in bold 11 pt.
- **3 pt gap**, then the **light**: one glyph in bold 13 pt, coloured by state.
- If the agent has a workspace/page number it follows the glyph after a
  space: `● 3`. Several numbers are comma separated: `● 1,3`.
- **8 pt** between badges, **6 pt** padding on each side of the row.
- The row hides itself (zero width) when no agent is visible.
- Clicking anywhere on the row toggles the popup (section 2.4).

### 2.2 Lights (glyph + colour), exact values

| State | Glyph | Colour | Meaning |
|---|---|---|---|
| `working` | `●` | `#4ecb71` green | agent is busy |
| `done` | `✓` | `#4ecb71` green | finished its last turn |
| `attention` | `●` | `#f5c84c` yellow | needs an approval or an answer |
| `error` | `●` | `#f16d6d` red | failed |
| `stopped` | `●` | `#f16d6d` red | aborted / session ended / abandoned |
| `idle` | `○` | `#8b929d` grey | no recent signal |

These are the colours from `BarWidget.qml`'s `colorFor()`; do not swap them
for system colours. In Swift: `AgentStatusStyle.color(for: state)`.

### 2.3 Which badges show, and in what order

Order: `codex`, `claude`, `hermes`, `herder`, then any custom agents from the
config in file order. Always this order, never re-sorted by state.

A badge is **visible** when any of these is true (status.py `collect()`):

1. the agent opted in with `showIdle` (built-ins: only Herdr; custom agents: default true), or
2. the agent's app process is running right now (`ps -eo comm=` contains
   `claude`, `hermes`, `herder`, `codex` or `chatgpt`; on macOS the last path
   component is compared, so `/Applications/Codex.app/Contents/MacOS/Codex` counts), or
3. its chosen state is `done`, `attention`, `error`, `stopped` or `working`
   and the event is less than **1 hour** old.

When one agent has several sessions (events), the badge shows the one with
the highest **priority**, ties broken by newest:
`attention (5) > error (4) > working (3) > done (2) > stopped (1) > idle (0)`.
A chosen `working` older than 1 hour is shown as `stopped` (a crashed agent
must never look busy forever).

### 2.4 The popup (click on the badges)

340 pt wide, 14 pt side padding, 10 pt between blocks:

```
LIVE AGENTS                                  (bold 11 pt)
3 ●  Codex        omac-native                 (left: 105 pt, coloured by state, 13 pt;
   ✓  Claude       agent-status                 right: project label or state, 11 pt, truncated)
   ○  Herdr        idle
───────────────────────────────────────────
SOUNDS                                       (bold 11 pt)
Working    [ Off        ▾ ]                   (label 95 pt, drop-down fills the rest)
Done       [ Complete   ▾ ]
Needs you  [ Message    ▾ ]
Stopped    [ Warning    ▾ ]
Problem    [ Warning    ▾ ]
```

Drop-down choices, in this order: `Off`, `Complete`, `Bell`, `Message`, `Warning`.
Choosing one saves it to the config and previews it immediately.

### 2.5 Sounds

Defaults: working Off, done Complete, attention Message, stopped Warning, error Warning.
A sound plays **once per state change per agent**, when a poll sees that an
agent's state differs from the previous snapshot. Nothing plays for the very
first snapshot. On the Mac the names map to system sounds:
Complete → `Glass`, Bell → `Ping`, Message → `Pop`, Warning → `Basso`
(`SoundName.macSystemSound`, played with `NSSound(named:)`). Change the mapping
there if Rick prefers other sounds; keep the five names, the config uses them.

### 2.6 Polling

The widget polls every **3 seconds** (`Timer interval 3000, triggeredOnStart`).
The Swift `AgentStatusController.start()` does the same on a utility queue
and updates the views on the main thread.

---

## 3. Where the states come from (per agent)

### 3.1 Codex: no hook, read its session logs

Scan `~/.codex/sessions/**/rollout-*.jsonl`:

1. Take the **16 newest** files by modification time; skip any older than **7 days**.
2. First line is `session_meta`; `payload.cwd` is the project folder.
3. Read the file **backwards** (64 KB chunks). The first `turn_context` seen
   from the end gives a newer `payload.cwd`. The first `event_msg` seen from
   the end decides the state: `task_started` → working, `task_complete` →
   done, `task_aborted` / `turn_aborted` → stopped. Stop reading once both are found.
4. If the state is working and the file was last modified more than
   **1 hour** ago → stopped.
5. Project label = last path component of `cwd`, max 32 characters. If the
   path contains `/Documents/Codex/` the label is the generic `Codex task`
   (that is the Codex app's own working folder, not a project).
6. The session id is the file name without `.jsonl`; `at` is the file's mtime.

Verified against Rick's real logs on mini 1 (Codex Desktop 0.163): the event
names are exactly these. Codex approval prompts are **not** in those logs, so
Codex never shows yellow from this source; that is a known limit of the
laptop version too.

### 3.2 Claude Code: hooks

`agent-status install-claude-hooks` adds five hooks to `~/.claude/settings.json`
(`UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `Stop`, `SessionEnd`),
each running `<path>/agent-status claude-hook <Event>` with the hook JSON on stdin.
Mapping (`ClaudeHook.state(forEvent:notificationType:)`):

| Hook event | State |
|---|---|
| `UserPromptSubmit`, `PreToolUse` | working |
| `Stop` | done |
| `SessionEnd` | stopped |
| `PermissionRequest` | attention |
| `Notification` with `notification_type` `permission_prompt`, `elicitation_dialog` or `elicitation_url_dialog` | attention |
| anything else | ignored |

Session = `session_id` (else `transcript_path`, else `"claude"`).
Project = `session_title` (else `cwd`).
Hooks must never fail the agent: the CLI exits 0 for anything it ignores.

### 3.3 Hermes, Herdr and custom agents: the event bridge

Two commands, identical to the Python bridge:

```sh
# public identifiers only (they show in `ps`):
agent-status event herder SESSION_ID working project-label

# private metadata (real paths, real session ids) goes on stdin, never on the command line:
printf '%s' '{"agent":"hermes","session":"abc","state":"attention","page":"/Users/rick/secret project"}' \
  | agent-status event-stdin
```

Accepted states: working, attention, done, stopped, error, idle.
The Hermes plugin at the repo root (`hermes_plugin.py`) does exactly this at
`pre_llm_call` (working), `on_session_end` (done / error / stopped),
`pre_approval_request` (attention), `post_approval_response` (working or
stopped), `agent_loop_stopped` (stopped); on the Mac point its `SCRIPT` at the
`agent-status` binary and change `event-stdin` to the same subcommand.

### 3.4 Custom agents (config)

`config.json` (`~/Library/Application Support/AgentStatus/config.json` on the Mac):

```json
{
  "agents": [
    { "id": "scout", "name": "Scout", "icon": "/Users/rick/Pictures/scout.png",
      "windowMatch": "Scout", "showIdle": true }
  ],
  "sounds": { "attention": "Bell" }
}
```

- `id`: `^[a-z][a-z0-9_-]{0,31}$`, otherwise the entry is ignored.
- `name`: max 32 characters; defaults to the id (or the built-in label).
- `icon`: absolute path, `~` path, or a file name relative to the config folder; must exist.
- `windowMatch`: string or list, lower-cased; used for workspace lookup.
- An entry whose id is a built-in (`codex`, `claude`, `hermes`, `herder`) overrides that built-in's name/icon in place.

### 3.5 Workspace / page numbers

On Linux the number is the Hyprland workspace of the agent's window
(`hyprctl clients -j`, matched by window class/title, `windowMatch`, or the
window's process tree). **On the Mac the port does not know OMAC's pages.**
`Collector.workspaces` is a closure `(AgentDefinition) -> [Int]` that returns
the numbers to show; the default returns none. OMAC should supply it: for
each agent, the page(s) where its terminal is tiled (OMAC already resolves
this for its own chips in `AgentInboxMenu.resolvingAgentPages`). This is the
one piece that must be written inside OMAC.

---

## 4. Privacy rules (keep them)

- Only **state, a SHA-256 hash of the session id (first 20 hex chars), and
  the last path component (≤ 32 chars)** are stored. Never prompts, tool
  arguments, full paths or credentials.
- Private values travel on **stdin**, not on the command line.
- Invalid input to `event-stdin` is rejected with exit 1 and the message
  `invalid event input`; nothing is echoed back.
- Each event is one small JSON file written atomically (temp file + rename).

Event file `events/<agent>/<hash>.json`:

```json
{"agent":"claude","session":"3f1c9a7b2e4d6c8a0b1f","state":"working",
 "page":"omac-native","source":"hook","at":1761090000.12}
```

Snapshot `snapshot.json` (what `poll` prints; `visibleAgents` is what the bar draws):

```json
{"agents":{"codex":{"agent":"codex","session":"rollout-…","state":"working","page":"Codex task",
  "source":"session","at":1761090000.0,"visible":true,"name":"Codex","icon":"","symbol":"●","workspace":""},
  "claude":{…},"hermes":{…},"herder":{…}},
 "order":["codex","claude","hermes","herder"],
 "sounds":{"working":"Off","done":"Complete","attention":"Message","stopped":"Warning","error":"Warning"},
 "at":1761090003.4}
```

---

## 5. File-by-file reference (Swift)

### `Sources/AgentStatusKit` (Foundation only; builds on Linux and macOS)

| File | Public API |
|---|---|
| `AgentState.swift` | `enum AgentState` (`priority`, `symbol`, `colorHex`, `soundLabel`, `soundStates`), `enum SoundName` (`macSystemSound`, `defaults`), `struct EventRecord`, `struct AgentBadge`, `struct Snapshot` (`visibleAgents`, `sound(for:)`) |
| `Paths.swift` | `AgentStatusPaths.standard(environment:home:)` → `stateRoot`, `events`, `snapshot`, `config`; `JSONFile.read/readObject/write/decode` (atomic rename) |
| `AgentConfig.swift` | `AgentDefinition`; `AgentConfig.definitions(paths:)`, `.sounds(config:)`, `.setSound(_:_:paths:)` |
| `EventStore.swift` | `EventStore.label(for:)`, `.sessionKey(_:agent:)`, `.writeEvent(agent:session:state:page:source:paths:…)`, `.recentEvents(paths:definitions:now:)`; `StdinEvent.parse(_:)`; `ClaudeHook.state(forEvent:notificationType:)`, `.interpret(eventName:payload:)`, `.handle(eventName:payload:paths:)` |
| `CodexSessions.swift` | `CodexSessions.scan(home:now:)`, `.parse(file:modified:now:)` |
| `ProcessScan.swift` | `ProcessScan.activeAgents()`, `.agents(fromCommandNames:)` |
| `Collector.swift` | `final class Collector(paths:workspaces:runningAgents:codexSessions:now:)`; `collect()` → `[(id, AgentBadge)]`; `poll()` → `(snapshot, sounds)` and writes `snapshot.json` |
| `ClaudeHookInstaller.swift` | `install(bridge:settings:)`, `remove(bridge:settings:)` for `~/.claude/settings.json` |
| `SHA256.swift` | `SHA256.hex(_:)` (same digest as Python `hashlib`) |

### `Sources/AgentStatusBar` (AppKit)

| File | Public API |
|---|---|
| `AgentStatusBarView.swift` | `AgentStatusStyle` (sizes, fonts, `color(for:)`), `AgentIcons.icon(for:)` (config PNG → installed app icon by bundle id → bundled `Icons/claude-icon.png`, `herdr-icon.png` → nil), `AgentBadgeView.apply(_:foreground:)`, `AgentStatusBarView.apply(_:)` + `onClick` + `foreground` |
| `AgentStatusPanelView.swift` | `AgentStatusPanelView.apply(_:)`, `onSoundChange`, `contentWidth = 340` |
| `AgentStatusController.swift` | `AgentStatusController(collector:barHeight:)`, `barView`, `panelView`, `snapshot`, `onSnapshot`, `start(interval:)`, `stop()`, `refresh()`, `togglePopup()`, `popupOpen`; `SoundPlayer.play(_:)` |

Bundle ids used for app icons: Codex `com.openai.codex`, `com.openai.chat`;
Claude `com.anthropic.claudefordesktop`; Hermes `com.nousresearch.hermes.setup`,
`com.nousresearch.hermes`. Add more in `AgentIcons.bundleIDs`.

### `Sources/agent-status` (command line)

```
agent-status poll                              print the snapshot JSON; play change sounds
agent-status claude-hook EVENT                 Claude Code hook, payload on stdin
agent-status event-stdin                       {"agent","session","state","page"} on stdin
agent-status event AGENT SESSION STATE [PAGE]  public identifiers only
agent-status sound STATE NAME                  save a sound choice and preview it
agent-status preview NAME                      play a sound
agent-status install-claude-hooks              add the five hooks to ~/.claude/settings.json
agent-status remove-claude-hooks               remove only our hooks
agent-status print-paths                       show state/events/config paths
```

Environment: `AGENT_STATUS_STATE_DIR`, `AGENT_STATUS_CONFIG`, `XDG_STATE_HOME`.

### `Sources/AgentStatusDemo`

A menu-bar app (`swift run AgentStatusDemo`, Control-C to quit) that puts
`AgentStatusController.barView` in an `NSStatusItem` and opens the popup on
click. Run it next to OMAC to compare the two bars side by side.

### `Tests/AgentStatusKitTests`

13 tests: SHA-256 vectors, path layout, stored events keep only hashed
session + label, invalid stdin rejected, unknown agent/state dropped,
positional `event` compatibility, label truncation, Claude hook mapping,
Codex rollout parsing (done/working/stale/old), collect priority and
visibility, custom agents and overrides, poll sounds on change, `ps` name
parsing for macOS and Linux.

---

## 6. Putting it into OMAC: step by step

1. **Dependency.** In OMAC's `Package.swift` add a local package
   dependency on this folder (or copy `Sources/AgentStatusKit` into
   `OmacCore` and `Sources/AgentStatusBar` into `OmacApp`; the AppKit files
   are wrapped in `#if canImport(AppKit)` and need the `Icons` resource folder):

   ```swift
   dependencies: [.package(path: "../agent-status-laptop-port")],
   // OmacApp target:
   dependencies: ["OmacCore", .product(name: "AgentStatusKit", package: "AgentStatus"),
                               .product(name: "AgentStatusBar", package: "AgentStatus")]
   ```

2. **One controller, owned by `NativeApp`.**

   ```swift
   let collector = Collector(paths: .standard())
   collector.workspaces = { [weak self] definition in
       // pages where this agent's terminal is tiled; reuse resolvingAgentPages logic
       self?.pages(forAgentNamed: definition.id) ?? []
   }
   let agentBar = AgentStatusController(collector: collector, barHeight: barHeight)
   agentBar.onSnapshot = { [weak self] _ in self?.relayoutBrandBar() }
   agentBar.start()
   ```

3. **Put `agentBar.barView` in the bar** (brand bar / status item button).
   Give it the bar height; it sets its own width and hides when empty. If
   the status item draws its title from an attributed string today
   (`applyAgentBadge`), replace that part with this view, or keep the
   attributed-string path and build it from `agentBar.snapshot.visibleAgents`
   using `AgentStatusStyle` colours, `badge.symbol`, `badge.workspace` and
   `AgentIcons.icon(for:)`. Either way the look must be icon + glyph + number.

4. **Popup.** `agentBar.togglePopup()` on click; the content is
   `agentBar.panelView`. If OMAC prefers its own menu, build the two
   sections from `snapshot.visibleAgents` and `AgentState.soundStates`, and
   call `AgentConfig.setSound(state, name, paths:)` + `SoundPlayer.play(name)`
   on change.

5. **Feed OMAC's existing reports into the same bar** (so agents that
   already write `<state>/agents/<id>.json` keep working):

   | OMAC state | Bar state |
   |---|---|
   | working | working |
   | approval, question, blocked | attention |
   | failed | error |
   | done | done |

   Simplest: in `AgentStatusWatcher`'s delivery, call
   `EventStore.writeEvent(agent: <mapped id>, session: entry.status.agentID, state: <mapped>, page: entry.status.detail, paths: collector.paths)`.
   Map the agent id to a bar id (`claude`, `codex`, `hermes`, `herder`) or
   register it as a custom agent in `config.json` so it gets a badge.

6. **Codex and Claude on the Mac need nothing from OMAC**: Codex is read
   from its logs; Claude reports once `agent-status install-claude-hooks`
   has been run (or OMAC installs the equivalent hook entries itself; the
   command is `agent-status claude-hook <Event>`). Ship the `agent-status`
   binary inside the app bundle (`Contents/Resources/Tools/`) like
   `omac-agent-status`.

7. **Threads.** `Collector.poll()` runs `ps`, reads up to 16 log files and
   the event files; keep it off the main thread (the controller already
   does). Views update on the main thread only.

8. **Test** with `swift test` here, then by eye: run `swift run
   AgentStatusDemo` next to OMAC and compare. Start a Codex task on mini 1:
   both bars must show the Codex icon with a green `●` within 3 seconds, and
   `✓` when it finishes, with the Complete sound once.

---

## 7. Known differences and open items

- **Workspace numbers** are empty until OMAC supplies pages (section 3.5).
- **Herdr icon / Claude icon** come from the widget's bundled PNGs when no
  app is installed; Codex and Hermes use the installed apps' icons.
- The Linux widget's `windowMatch` is only used for workspace lookup; on the
  Mac it is parsed and kept for OMAC to use in the `workspaces` closure.
- `agent-status poll` plays sounds itself; when the bar is inside OMAC the
  controller plays them. Do not run both pollers against the same state
  folder or sounds double.
- Sound files: Linux uses freedesktop `.oga` files via `pw-play`; the Mac
  uses system sounds (section 2.5).

---

## 8. Build, test, run (on the Mac)

```sh
cd ~/Documents/Codex/2026-09-22/omac-native-rebuild/outputs/agent-status-laptop-port
swift build
swift test
.build/debug/agent-status poll | python3 -m json.tool | head -40
swift run AgentStatusDemo            # menu-bar demo, Control-C to quit
```

Keep the Linux widget as the source of truth: when the laptop bar changes,
change `macos/` to match and re-copy. Questions about intent go to Rick; he
is not a programmer, so explain in plain words.
