import Foundation
import AgentStatusKit
#if canImport(AppKit)
import AppKit
#endif

// Command-line bridge: the same commands as status.py, so agents and hooks that
// could talk to the Linux widget can talk to the Mac one.
//
//   agent-status poll                                   print the snapshot JSON (and play change sounds)
//   agent-status claude-hook EVENT                      Claude Code hook (payload on stdin)
//   agent-status event-stdin                            {"agent","session","state","page"} on stdin
//   agent-status event AGENT SESSION STATE [PAGE]       public identifiers only
//   agent-status sound STATE NAME                       store a sound choice and preview it
//   agent-status preview NAME                           play a sound
//   agent-status install-claude-hooks | remove-claude-hooks
//   agent-status print-paths

let usage = "usage: agent-status poll | claude-hook EVENT | event-stdin | event AGENT SESSION STATE [PAGE] | sound STATE NAME | preview NAME | install-claude-hooks | remove-claude-hooks | print-paths"

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

func play(_ name: SoundName) {
    #if canImport(AppKit)
    guard let system = name.macSystemSound, let sound = NSSound(named: system) else { return }
    sound.play()
    // NSSound plays asynchronously; give it a moment before the process ends.
    Thread.sleep(forTimeInterval: min(1.5, sound.duration))
    #endif
}

let paths = AgentStatusPaths.standard()
let args = Array(CommandLine.arguments.dropFirst())
guard let command = args.first else { fail(usage) }

switch command {
case "poll":
    let result = Collector(paths: paths).poll()
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    if let data = try? encoder.encode(result.snapshot) { print(String(decoding: data, as: UTF8.self)) }
    for name in result.sounds { play(name) }
case "claude-hook" where args.count == 2:
    ClaudeHook.handle(eventName: args[1], payload: FileHandle.standardInput.readDataToEndOfFile(), paths: paths)
case "event-stdin" where args.count == 1:
    guard let event = StdinEvent.parse(FileHandle.standardInput.readDataToEndOfFile()) else { fail("invalid event input") }
    EventStore.writeEvent(agent: event.agent, session: event.session, state: event.state, page: event.page, paths: paths)
case "event" where args.count >= 4:
    EventStore.writeEvent(agent: args[1], session: args[2], state: args[3], page: args.count > 4 ? args[4] : "", paths: paths)
case "sound" where args.count == 3:
    guard let state = AgentState(rawValue: args[1]), AgentState.soundStates.contains(state),
          let name = SoundName(rawValue: args[2]) else { fail("invalid status command") }
    do { try AgentConfig.setSound(state, name, paths: paths) } catch { fail("could not save sound choice: \(error)") }
    play(name)
case "preview" where args.count == 2:
    guard let name = SoundName(rawValue: args[1]) else { fail("invalid status command") }
    play(name)
case "install-claude-hooks":
    do { try ClaudeHookInstaller.install(bridge: CommandLine.arguments[0]) } catch { fail("could not update Claude settings: \(error)") }
    print("Claude Code hooks installed. New sessions will report their status.")
case "remove-claude-hooks":
    do { try ClaudeHookInstaller.remove(bridge: CommandLine.arguments[0]) } catch { fail("could not update Claude settings: \(error)") }
    print("Agent status hooks removed from Claude Code settings.")
case "print-paths":
    print("state:  \(paths.stateRoot.path)\nevents: \(paths.events.path)\nconfig: \(paths.config.path)")
default:
    fail(usage)
}
