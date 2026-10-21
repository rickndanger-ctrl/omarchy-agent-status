import Foundation

/// Codex needs no hook: its local session records (`~/.codex/sessions/**/rollout-*.jsonl`)
/// say when a task started, finished or was aborted (status.py codex_sessions).
public enum CodexSessions {
    public static func scan(home: URL = FileManager.default.homeDirectoryForCurrentUser, now: Date = Date()) -> [EventRecord] {
        let base = home.appendingPathComponent(".codex/sessions", isDirectory: true)
        guard let enumerator = FileManager.default.enumerator(at: base, includingPropertiesForKeys: [.contentModificationDateKey]) else { return [] }
        var files: [(URL, Date)] = []
        for case let url as URL in enumerator where url.lastPathComponent.hasPrefix("rollout-") && url.pathExtension == "jsonl" {
            let modified = (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast
            files.append((url, modified))
        }
        files.sort { $0.1 > $1.1 }
        return files.prefix(16).compactMap { parse(file: $0.0, modified: $0.1, now: now) }
    }

    /// Read one rollout file: first line gives the folder, the newest event gives the state.
    public static func parse(file: URL, modified: Date, now: Date) -> EventRecord? {
        let age = now.timeIntervalSince(modified)
        if age > 7 * 86400 { return nil }
        guard let handle = try? FileHandle(forReadingFrom: file) else { return nil }
        defer { try? handle.close() }
        var page = ""
        var state = AgentState.idle
        if let first = firstLine(handle), let meta = json(first),
           let payload = meta["payload"] as? [String: Any], let cwd = payload["cwd"] as? String {
            page = cwd
        }
        var foundState = false, foundPage = false
        for line in reverseLines(handle) {
            guard let item = json(line) else { continue }
            let type = item["type"] as? String
            let payload = item["payload"] as? [String: Any] ?? [:]
            if !foundPage, type == "turn_context", let cwd = payload["cwd"] as? String, !cwd.isEmpty {
                page = cwd
                foundPage = true
            }
            if !foundState, type == "event_msg" {
                switch payload["type"] as? String {
                case "task_started": state = .working; foundState = true
                case "task_complete": state = .done; foundState = true
                case "task_aborted", "turn_aborted": state = .stopped; foundState = true
                default: break
                }
            }
            if foundState && foundPage { break }
        }
        // A crashed or abandoned process must not show working forever.
        if state == .working, age > 3600 { state = .stopped }
        var label = EventStore.label(for: page)
        if page.contains("/Documents/Codex/") { label = "Codex task" }
        let stem = file.deletingPathExtension().lastPathComponent
        return EventRecord(agent: "codex", session: stem, state: state, page: label, source: "session",
                           at: modified.timeIntervalSince1970)
    }

    private static func json(_ line: Data) -> [String: Any]? {
        (try? JSONSerialization.jsonObject(with: line)) as? [String: Any]
    }

    private static func firstLine(_ handle: FileHandle) -> Data? {
        try? handle.seek(toOffset: 0)
        var buffer = Data()
        while true {
            guard let chunk = try? handle.read(upToCount: 65536), !chunk.isEmpty else { break }
            buffer.append(chunk)
            if let newline = buffer.firstIndex(of: 0x0a) { return buffer.subdata(in: 0..<newline) }
            if buffer.count > 4_000_000 { break }
        }
        return buffer.isEmpty ? nil : buffer
    }

    /// Lines from the end of the file, newest first, reading 64 KB at a time (status.py reverse_lines).
    private static func reverseLines(_ handle: FileHandle) -> [Data] {
        guard let end = try? handle.seekToEnd() else { return [] }
        var lines: [Data] = []
        var position = end
        var pending = Data()
        while position > 0 {
            let size = min(UInt64(65536), position)
            position -= size
            try? handle.seek(toOffset: position)
            guard let chunk = try? handle.read(upToCount: Int(size)) else { break }
            pending = chunk + pending
            var parts = pending.split(separator: 0x0a, omittingEmptySubsequences: false).map { Data($0) }
            pending = parts.removeFirst()
            for line in parts.reversed() where !line.isEmpty { lines.append(line) }
        }
        if !pending.isEmpty { lines.append(pending) }
        return lines
    }
}
