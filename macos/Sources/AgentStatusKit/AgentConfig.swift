import Foundation

/// One badge definition: the four built-ins plus anything from the config file
/// (status.py agent_definitions()).
public struct AgentDefinition: Equatable {
    public var id: String
    public var name: String
    /// Absolute path to a PNG, or "" (use the app icon, else the name).
    public var icon: String
    /// Lower-cased fragments of a window class/title that place this agent on a workspace.
    public var windowMatch: [String]
    /// Show the badge even with no recent event (built-ins: only Herdr; config entries: default true).
    public var showIdle: Bool

    public init(id: String, name: String, icon: String = "", windowMatch: [String] = [], showIdle: Bool) {
        self.id = id; self.name = name; self.icon = icon; self.windowMatch = windowMatch; self.showIdle = showIdle
    }
}

public enum AgentConfig {
    public static let builtInAgents = ["codex", "claude", "hermes", "herder"]
    public static let builtInLabels = ["codex": "Codex", "claude": "Claude", "hermes": "Hermes", "herder": "Herdr"]

    /// Built-in agents first, then user agents from the config in file order.
    /// A config entry with a built-in id overrides that built-in in place.
    public static func definitions(config: [String: Any], configDirectory: URL?) -> [AgentDefinition] {
        var order = builtInAgents
        var byID: [String: AgentDefinition] = [:]
        for agent in builtInAgents {
            byID[agent] = AgentDefinition(id: agent, name: builtInLabels[agent] ?? agent, showIdle: agent == "herder")
        }
        let idPattern = try! NSRegularExpression(pattern: "^[a-z][a-z0-9_-]{0,31}$")
        for item in config["agents"] as? [Any] ?? [] {
            guard let item = item as? [String: Any], let id = item["id"] as? String,
                  idPattern.firstMatch(in: id, range: NSRange(id.startIndex..., in: id)) != nil else { continue }
            var name = builtInLabels[id] ?? id
            if let given = item["name"] as? String, !given.trimmingCharacters(in: .whitespaces).isEmpty {
                name = String(given.prefix(32))
            }
            var icon = ""
            if let given = item["icon"] as? String, !given.isEmpty {
                var url = URL(fileURLWithPath: (given as NSString).expandingTildeInPath)
                if !given.hasPrefix("/") && !given.hasPrefix("~"), let base = configDirectory {
                    url = base.appendingPathComponent(given)
                }
                var isDirectory: ObjCBool = false
                if FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory), !isDirectory.boolValue {
                    icon = url.path
                }
            }
            var match: [String] = []
            if let one = item["windowMatch"] as? String { match = [one] }
            else if let many = item["windowMatch"] as? [Any] { match = many.compactMap { $0 as? String } }
            match = match.filter { !$0.isEmpty }.map { $0.lowercased() }
            let showIdle = item["showIdle"] as? Bool ?? true
            if byID[id] == nil { order.append(id) }
            byID[id] = AgentDefinition(id: id, name: name, icon: icon, windowMatch: match, showIdle: showIdle)
        }
        return order.compactMap { byID[$0] }
    }

    public static func definitions(paths: AgentStatusPaths) -> [AgentDefinition] {
        definitions(config: JSONFile.readObject(paths.config), configDirectory: paths.config.deletingLastPathComponent())
    }

    /// Default sounds overlaid with the config's "sounds" object.
    public static func sounds(config: [String: Any]) -> [String: String] {
        var sounds = Dictionary(uniqueKeysWithValues: SoundName.defaults.map { ($0.key.rawValue, $0.value.rawValue) })
        for (state, name) in config["sounds"] as? [String: Any] ?? [:] {
            if let name = name as? String { sounds[state] = name }
        }
        return sounds
    }

    /// Persist one sound choice (status.py `sound STATE NAME`).
    public static func setSound(_ state: AgentState, _ name: SoundName, paths: AgentStatusPaths) throws {
        var config = JSONFile.readObject(paths.config)
        var sounds = config["sounds"] as? [String: Any] ?? [:]
        sounds[state.rawValue] = name.rawValue
        config["sounds"] = sounds
        try JSONFile.write(config, to: paths.config)
    }
}
