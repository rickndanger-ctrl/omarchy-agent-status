# Agent Status Bar – Swift port for the Mac (OMAC)

This is the Omarchy bar widget from the repo root (`BarWidget.qml` + `status.py`),
rewritten in Swift so OMAC on the Mac can show the same Agent Status Bar.
Behaviour was ported line by line from the Linux version; the Linux version
stays the source of truth.

## What the bar does (the part to match in OMAC)

One compact badge per agent: **icon (or name) + coloured light + workspace number**.

| Light | Meaning |
| --- | --- |
| Green `✓` | Done |
| Green `●` | Working |
| Yellow `●` | Approval or answer needed |
| Red `●` | Stopped or problem |
| Grey `○` | Idle (no recent signal) |

Colours are exactly the widget's: `#4ecb71` working/done, `#f5c84c` attention,
`#f16d6d` error/stopped, `#8b929d` idle. Badges: 17 pt icon, 3 pt gap, bold
13 pt light, 8 pt between badges. A badge is shown when the agent has a
recent event (last hour), its app is running, or the agent opts in to
`showIdle` (Herdr does by default). Clicking the badges opens a popup with
**LIVE AGENTS** (workspace, light, name, project label) and **SOUNDS** (one
drop-down per state: Off / Complete / Bell / Message / Warning). A sound
plays once when an agent's state changes.

Where the states come from:

- **Codex**: no hook. `~/.codex/sessions/**/rollout-*.jsonl` is scanned
  (newest 16 files, last 7 days); `task_started` = working, `task_complete`
  = done, `task_aborted`/`turn_aborted` = stopped; the project label is the
  last folder of `cwd`. A session untouched for an hour never stays "working".
- **Claude Code**: hooks call `agent-status claude-hook EVENT`
  (`UserPromptSubmit`/`PreToolUse` → working, `Stop` → done, `SessionEnd` →
  stopped, `PermissionRequest` or a permission/elicitation `Notification` → attention).
- **Hermes / Herdr / your own agents**: send `{"agent","session","state","page"}`
  on stdin to `agent-status event-stdin`. Only the state, a SHA-256-hashed
  session id and the last path component (32 chars) are stored, never prompts.
- When several sessions of one agent exist, the blocking state wins
  (attention > error > working > done > stopped > idle), then the newest.

## Layout

```
Package.swift
Sources/AgentStatusKit/      logic, Foundation only (also builds and tests on Linux)
  AgentState.swift           states, priorities, symbols, colours, sounds, Snapshot
  Paths.swift                state/config locations, atomic JSON writes
  AgentConfig.swift          config file: custom agents, icon paths, sound choices
  EventStore.swift           event files, stdin events, Claude hook mapping
  CodexSessions.swift        Codex session-log scan
  ProcessScan.swift          which agent apps are running (ps)
  Collector.swift            collect() + poll(): the snapshot the bar draws
  ClaudeHookInstaller.swift  adds/removes the hooks in ~/.claude/settings.json
  SHA256.swift               same hashing as hashlib on Linux
Sources/AgentStatusBar/      AppKit
  AgentStatusBarView.swift   AgentBadgeView + AgentStatusBarView (the badges row), icons, colours
  AgentStatusPanelView.swift the popup (LIVE AGENTS + SOUNDS)
  AgentStatusController.swift 3 s polling, sounds, popover
  Icons/                     the original Claude and Herdr icons from the widget
Sources/agent-status/        command-line bridge, same commands as status.py
Sources/AgentStatusDemo/     menu-bar demo app to look at the bar
Tests/AgentStatusKitTests/   13 tests (privacy, Codex parsing, priority, sounds, hooks)
```

## Build and try

```sh
swift build
swift test
swift run agent-status poll          # prints the snapshot JSON
swift run AgentStatusDemo            # menu-bar demo, Control-C to quit
swift run agent-status install-claude-hooks   # optional: Claude Code reports to it
```

Paths on the Mac: state in `~/Library/Application Support/AgentStatus`
(`events/`, `snapshot.json`, `config.json`). `AGENT_STATUS_STATE_DIR`,
`AGENT_STATUS_CONFIG` and `XDG_STATE_HOME` override them.

## Putting it into OMAC

1. Add `AgentStatusKit` and `AgentStatusBar` to OMAC's package (local path
   dependency, or copy the two source folders into `OmacCore`/`OmacApp`).
2. Create one `AgentStatusController(collector: Collector(paths: .standard()))`
   and put `controller.barView` into the brand bar / menu-bar item. Set the
   view's height to the bar height; it sizes its own width and hides itself
   when nothing is visible. `controller.onSnapshot` fires after every poll.
3. Workspace numbers: on Linux they are Hyprland workspaces. For OMAC set
   `collector.workspaces = { definition in pages where that agent's terminal is tiled }`
   so the badge reads `● 3` like on the laptop. The default shows no number.
4. OMAC's existing report files (`<state>/agents/<id>.json`, states
   working/approval/question/blocked/failed/done) can feed the same bar:
   map approval/question/blocked → `attention`, failed → `error`, and call
   `EventStore.writeEvent(agent:session:state:page:paths:)`, or keep both
   readers and merge in `Collector.codexSessions`/`runningAgents` closures.
5. The popup is `controller.panelView` (340 pt wide); `controller.togglePopup()`
   shows it in an NSPopover under the bar view.

Everything that reads files or runs `ps` happens off the main thread in
`AgentStatusController.refresh()`; the views only ever update on the main thread.
