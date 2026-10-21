import Foundation

/// Adds or removes the five Claude Code hooks in ~/.claude/settings.json
/// (setup_integrations.py install_claude / remove_claude).
public enum ClaudeHookInstaller {
    public static let events = ["UserPromptSubmit", "PreToolUse", "PermissionRequest", "Stop", "SessionEnd"]

    public static func settingsFile(home: URL = FileManager.default.homeDirectoryForCurrentUser) -> URL {
        home.appendingPathComponent(".claude/settings.json")
    }

    /// The command prefix every hook shares; used to recognise our own entries.
    public static func prefix(bridge: String) -> String {
        let absolute = URL(fileURLWithPath: bridge).standardizedFileURL.path
        return "\(quoted(absolute)) claude-hook "
    }

    static func quoted(_ path: String) -> String {
        let safe = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "@%+=:,./-_"))
        if path.unicodeScalars.allSatisfy({ safe.contains($0) }) { return path }
        return "'" + path.replacingOccurrences(of: "'", with: "'\"'\"'") + "'"
    }

    public static func install(bridge: String, settings url: URL = settingsFile()) throws {
        var settings = JSONFile.readObject(url)
        var hooks = settings["hooks"] as? [String: Any] ?? [:]
        let prefix = prefix(bridge: bridge)
        for event in events {
            var existing = (hooks[event] as? [[String: Any]] ?? []).filter { !isOurs($0, prefix: prefix) }
            existing.append(["hooks": [["type": "command", "command": prefix + event, "timeout": 5]]])
            hooks[event] = existing
        }
        settings["hooks"] = hooks
        try JSONFile.write(settings, to: url)
    }

    public static func remove(bridge: String, settings url: URL = settingsFile()) throws {
        guard FileManager.default.fileExists(atPath: url.path) else { return }
        var settings = JSONFile.readObject(url)
        var hooks = settings["hooks"] as? [String: Any] ?? [:]
        let prefix = prefix(bridge: bridge)
        for event in events {
            let kept = (hooks[event] as? [[String: Any]] ?? []).filter { !isOurs($0, prefix: prefix) }
            if kept.isEmpty { hooks.removeValue(forKey: event) } else { hooks[event] = kept }
        }
        if hooks.isEmpty { settings.removeValue(forKey: "hooks") } else { settings["hooks"] = hooks }
        try JSONFile.write(settings, to: url)
    }

    static func isOurs(_ group: [String: Any], prefix: String) -> Bool {
        (group["hooks"] as? [[String: Any]] ?? []).contains { ($0["command"] as? String ?? "").hasPrefix(prefix) }
    }
}
