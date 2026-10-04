# Live Agent Status for Omarchy

A bar widget for Codex, Claude Code, Hermes, and Herder. The badge shows the agent, its live state, its Omarchy workspace number when a window can be identified, and a short project label. Click the bar widget to choose sounds for state changes.

| Badge | Meaning |
| --- | --- |
| Green checkmark | Done |
| Green dot | Working |
| Yellow dot | Approval or answer needed |
| Red dot | Stopped or problem |
| Gray circle | Idle or no current signal |

The `#N` immediately beside an icon is the Hyprland workspace number. It updates when the window moves. No number is shown when the agent has no identifiable window. This is a desktop workspace number, not a document page number.

## Install

From a public Git repository:

```sh
omarchy plugin add https://github.com/rickndanger-ctrl/omarchy-agent-status.git --enable
python3 ~/.config/omarchy/plugins/rickom1.agent-status/setup_integrations.py
```

The second command opts in to Claude Code and Hermes event hooks. Use `--claude` or `--hermes` to install only one. Codex reads its local session records without an extra hook. Herder appears as an idle badge and can publish events using the local bridge described below.

`omarchy plugin add` installs the plugin but does not run the integration helper automatically. Review the helper before running it. A newly enabled Hermes plugin takes effect in new Hermes sessions.

## Herder event bridge

Herder can send status events without changing the widget:

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
- The Codex and Hermes images are loaded from locally installed app icons when present; the widget falls back to a letter otherwise. The Claude favicon is sourced from Claude and remains Anthropic's trademark. It is not covered by the code license.
- Plugin code runs with your user permissions inside `omarchy-shell`. Review it before installing.

## Remove

```sh
omarchy plugin disable rickom1.agent-status
omarchy plugin remove rickom1.agent-status
```

The optional Claude and Hermes hooks are stored in those applications' user configuration and should be removed there separately if no longer wanted.

## License

The code is MIT licensed. See `LICENSE`.
