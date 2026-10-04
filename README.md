# Live Agent Status for Omarchy

A bar widget for Codex, Claude Code, Hermes, Herdr, and agents you add. Each compact badge shows an icon (or name), live status, and its Omarchy workspace number when a window can be identified. Click the widget to see details and choose sounds.

| Badge | Meaning |
| --- | --- |
| Green checkmark | Done |
| Green dot | Working |
| Yellow dot | Approval or answer needed |
| Red dot | Stopped or problem |
| Gray circle | Idle or no current signal |

The number beside a status light is the Hyprland workspace number. It updates when the window moves. No number is shown when the agent has no identifiable window. This is a desktop workspace number, not a document page number.

## Install

From a public Git repository:

```sh
omarchy plugin add https://github.com/rickndanger-ctrl/omarchy-agent-status.git --enable
python3 ~/.config/omarchy/plugins/rickom1.agent-status/setup_integrations.py
```

The second command opts in to Claude Code and Hermes event hooks. Use `--claude` or `--hermes` to install only one. Codex reads its local session records without an extra hook. Herdr appears as an idle badge and can publish events using the local bridge described below.

Restart any Hermes chat that was already running when the hook was installed. Hermes loads plugins at session startup. The bar shows a workspace number only when the agent has a visible Omarchy window; a detached tmux session has no desktop workspace number until attached to a terminal window.

## Add an agent

Add an entry to `~/.config/omarchy/agent-status.json`. An icon can be an absolute PNG path, or a filename placed in the plugin directory. `windowMatch` is an optional fragment of the window class or title used to find the workspace. Set `showIdle` to `false` to show the badge only while it has a recent status event.

```json
{
  "agents": [
    {
      "id": "scout",
      "name": "Scout",
      "icon": "/home/YOU/Pictures/scout.png",
      "windowMatch": "Scout",
      "showIdle": true
    }
  ]
}
```

The agent (or its launcher) can send status changes through the bridge:

```sh
python3 ~/.config/omarchy/plugins/rickom1.agent-status/status.py event scout SESSION_ID working /path/to/project
python3 ~/.config/omarchy/plugins/rickom1.agent-status/status.py event scout SESSION_ID done /path/to/project
```

Use a stable session ID for each conversation. The accepted states are listed below. The configuration can also override the `name` or `icon` of a built-in badge by using its ID (`codex`, `claude`, `hermes`, or `herder`). This config does not replace an agent's own hook; connect its start, approval, completion, and error events to the bridge.

`omarchy plugin add` installs the plugin but does not run the integration helper automatically. Review the helper before running it. A newly enabled Hermes plugin takes effect in new Hermes sessions.

## Herdr event bridge

Herdr can send status events without changing the widget (the event ID remains `herder`):

```sh
python3 ~/.config/omarchy/plugins/rickom1.agent-status/status.py event herder SESSION_ID working /path/to/project
python3 ~/.config/omarchy/plugins/rickom1.agent-status/status.py event herder SESSION_ID attention /path/to/project
python3 ~/.config/omarchy/plugins/rickom1.agent-status/status.py event herder SESSION_ID done /path/to/project
```

Accepted states are `working`, `attention`, `done`, `stopped`, `error`, and `idle`. The bridge stores only state, a hashed session identifier, and the final component of the project path. Event records expire from the active display after one hour.

## Requirements and notes

- Omarchy with Quickshell plugin support, Hyprland, Python 3, and `hyprctl`.
- `pw-play` plus Freedesktop sound files for audible alerts. Missing files simply leave alerts silent.
- Codex status comes from local session records. Its approval prompts are not currently observable through those records, so the yellow state is reliable for Claude Code and Hermes hooks, and available to Herder through the event bridge.
- Claude and Herdr use original bundled icons; Codex and Hermes use local app icons when present. Custom agents can use their own icon path. If an image is unavailable, the widget shows the agent name. No third-party icons are bundled.
- Plugin code runs with your user permissions inside `omarchy-shell`. Review it before installing.

## Remove

```sh
python3 ~/.config/omarchy/plugins/rickom1.agent-status/setup_integrations.py --remove
omarchy plugin disable rickom1.agent-status
omarchy plugin remove rickom1.agent-status
```

The cleanup helper removes only its Claude Code hooks and disables the Hermes plugin. It removes Hermes files only when they still match the installed originals. Use `--remove --claude` or `--remove --hermes` to remove one integration.

## License

The code is MIT licensed. See `LICENSE`.
