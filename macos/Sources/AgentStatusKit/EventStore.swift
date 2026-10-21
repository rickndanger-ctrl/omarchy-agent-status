import Foundation

/// Writing and reading the per-session event files (status.py write_event / collect).
public enum EventStore {
    /// The final path component, at most 32 characters (status.py label_for).
    public static func label(for path: String) -> String {
        let name = path.split(separator: "/", omittingEmptySubsequences: true).last.map(String.init) ?? ""
        return String(name.prefix(32))
    }

    /// Hash a session id to the 20-hex-character key the Linux bridge uses.
    public static func sessionKey(_ session: String, agent: String) -> String {
        String(SHA256.hex(session.isEmpty ? agent : session).prefix(20))
    }

    /// Store one event. Unknown agents and states are dropped silently, like the Python bridge.
    @discardableResult
    public static func writeEvent(agent: String, session: String, state: AgentState, page: String = "",
                                  source: String = "hook", paths: AgentStatusPaths,
                                  definitions: [AgentDefinition]? = nil, now: Date = Date()) -> EventRecord? {
        let known = definitions ?? AgentConfig.definitions(paths: paths)
        guard known.contains(where: { $0.id == agent }) else { return nil }
        let key = sessionKey(session, agent: agent)
        let record = EventRecord(agent: agent, session: key, state: state, page: label(for: page),
                                 source: source, at: now.timeIntervalSince1970)
        let url = paths.events.appendingPathComponent(agent, isDirectory: true).appendingPathComponent("\(key).json")
        do { try JSONFile.write(record, to: url) } catch { return nil }
        return record
    }

    @discardableResult
    public static func writeEvent(agent: String, session: String, state: String, page: String = "",
                                  paths: AgentStatusPaths) -> EventRecord? {
        guard let state = AgentState(rawValue: state) else { return nil }
        return writeEvent(agent: agent, session: session, state: state, page: page, paths: paths)
    }

    /// Stored events younger than an hour for known agents.
    public static func recentEvents(paths: AgentStatusPaths, definitions: [AgentDefinition], now: Date = Date()) -> [EventRecord] {
        let known = Set(definitions.map(\.id))
        var result: [EventRecord] = []
        let agentDirectories = (try? FileManager.default.contentsOfDirectory(at: paths.events, includingPropertiesForKeys: nil)) ?? []
        for directory in agentDirectories {
            let files = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? []
            for file in files where file.pathExtension == "json" {
                guard let record = JSONFile.decode(EventRecord.self, from: file), known.contains(record.agent),
                      now.timeIntervalSince1970 - record.at < 3600 else { continue }
                result.append(record)
            }
        }
        return result
    }
}

/// The `event-stdin` command: private metadata arrives on stdin as JSON, never on the command line.
public enum StdinEvent {
    public struct Parsed: Equatable {
        public var agent: String, session: String, state: String, page: String
    }

    /// Exactly the Python validation: an object with string agent/session/state and an optional string page.
    public static func parse(_ data: Data) -> Parsed? {
        guard let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let agent = object["agent"] as? String, let session = object["session"] as? String,
              let state = object["state"] as? String else { return nil }
        let page: String
        if let value = object["page"] {
            guard let text = value as? String else { return nil }
            page = text
        } else {
            page = ""
        }
        return Parsed(agent: agent, session: session, state: state, page: page)
    }
}

/// Claude Code hook payload → event (status.py claude_hook).
public enum ClaudeHook {
    public static func state(forEvent eventName: String, notificationType: String?) -> AgentState? {
        switch eventName {
        case "UserPromptSubmit", "PreToolUse": return .working
        case "Stop": return .done
        case "SessionEnd": return .stopped
        case "PermissionRequest": return .attention
        case "Notification":
            if let type = notificationType, ["permission_prompt", "elicitation_dialog", "elicitation_url_dialog"].contains(type) {
                return .attention
            }
            return nil
        default: return nil
        }
    }

    /// Returns (session, page, state) from the hook JSON, or nil when the event carries no state.
    public static func interpret(eventName: String, payload: Data) -> (session: String, page: String, state: AgentState)? {
        let object = (try? JSONSerialization.jsonObject(with: payload)) as? [String: Any] ?? [:]
        let session = (object["session_id"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            ?? (object["transcript_path"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "claude"
        let page = (object["session_title"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            ?? (object["cwd"] as? String) ?? ""
        guard let state = state(forEvent: eventName, notificationType: object["notification_type"] as? String) else { return nil }
        return (session, page, state)
    }

    @discardableResult
    public static func handle(eventName: String, payload: Data, paths: AgentStatusPaths) -> EventRecord? {
        guard let result = interpret(eventName: eventName, payload: payload) else { return nil }
        return EventStore.writeEvent(agent: "claude", session: result.session, state: result.state, page: result.page, paths: paths)
    }
}
