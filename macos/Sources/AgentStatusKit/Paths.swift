import Foundation
#if canImport(Glibc)
import Glibc
#elseif canImport(Darwin)
import Darwin
#endif

/// Where events, the snapshot and the config live.
///
/// Linux widget: `$XDG_STATE_HOME/omarchy/agent-status` and `~/.config/omarchy/agent-status.json`.
/// macOS default: `~/Library/Application Support/AgentStatus` (events/, snapshot.json, config.json).
/// `AGENT_STATUS_STATE_DIR` / `AGENT_STATUS_CONFIG` override both; `XDG_STATE_HOME` is honoured
/// on every platform so the test suite and a copied Linux setup behave the same.
public struct AgentStatusPaths: Equatable {
    public let stateRoot: URL
    public let config: URL

    public init(stateRoot: URL, config: URL) {
        self.stateRoot = stateRoot
        self.config = config
    }

    public var events: URL { stateRoot.appendingPathComponent("events", isDirectory: true) }
    public var snapshot: URL { stateRoot.appendingPathComponent("snapshot.json") }

    public static func standard(environment: [String: String] = ProcessInfo.processInfo.environment,
                                home: URL = FileManager.default.homeDirectoryForCurrentUser) -> AgentStatusPaths {
        let stateRoot: URL
        if let explicit = environment["AGENT_STATUS_STATE_DIR"], !explicit.isEmpty {
            stateRoot = URL(fileURLWithPath: explicit, isDirectory: true)
        } else if let xdg = environment["XDG_STATE_HOME"], !xdg.isEmpty {
            stateRoot = URL(fileURLWithPath: xdg, isDirectory: true).appendingPathComponent("omarchy/agent-status", isDirectory: true)
        } else {
            #if os(macOS)
            stateRoot = home.appendingPathComponent("Library/Application Support/AgentStatus", isDirectory: true)
            #else
            stateRoot = home.appendingPathComponent(".local/state/omarchy/agent-status", isDirectory: true)
            #endif
        }
        let config: URL
        if let explicit = environment["AGENT_STATUS_CONFIG"], !explicit.isEmpty {
            config = URL(fileURLWithPath: explicit)
        } else {
            #if os(macOS)
            config = stateRoot.appendingPathComponent("config.json")
            #else
            config = home.appendingPathComponent(".config/omarchy/agent-status.json")
            #endif
        }
        return AgentStatusPaths(stateRoot: stateRoot, config: config)
    }
}

/// Small JSON helpers with the same behaviour as status.py (atomic replace, tolerant reads).
public enum JSONFile {
    public static func read(_ url: URL) -> Any? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONSerialization.jsonObject(with: data)
    }

    public static func readObject(_ url: URL) -> [String: Any] {
        read(url) as? [String: Any] ?? [:]
    }

    /// Write to a temp file next to the target, then rename: readers never see a half file.
    public static func write(_ object: Any, to url: URL) throws {
        let directory = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        let temp = directory.appendingPathComponent(url.lastPathComponent + ".\(getpid()).tmp")
        try data.write(to: temp)
        // POSIX rename is atomic and overwrites on both macOS and Linux
        // (FileManager.replaceItemAt is not reliable on Linux Foundation).
        guard rename(temp.path, url.path) == 0 else {
            let code = errno
            try? FileManager.default.removeItem(at: temp)
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(code), userInfo: [NSFilePathErrorKey: url.path])
        }
    }

    public static func write<T: Encodable>(_ value: T, to url: URL) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data = try encoder.encode(value)
        let object = try JSONSerialization.jsonObject(with: data)
        try write(object, to: url)
    }

    public static func decode<T: Decodable>(_ type: T.Type, from url: URL) -> T? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(type, from: data)
    }
}
