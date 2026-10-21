import Foundation

/// Which agent apps are running right now (status.py active_processes). A running
/// app keeps its badge visible even when it has no recent event.
public enum ProcessScan {
    public static func activeAgents() -> Set<String> {
        guard let output = run(["/bin/ps", "-eo", "comm="]) else { return [] }
        return agents(fromCommandNames: output.split(separator: "\n").map(String.init))
    }

    /// macOS `ps` prints full executable paths; Linux prints bare names. Both are handled.
    public static func agents(fromCommandNames names: [String]) -> Set<String> {
        var found: Set<String> = []
        for raw in names {
            let name = raw.trimmingCharacters(in: .whitespaces).split(separator: "/").last.map { String($0).lowercased() } ?? ""
            if ["claude", "hermes", "herder"].contains(name) { found.insert(name) }
            if ["chatgpt", "codex"].contains(name) { found.insert("codex") }
        }
        return found
    }

    static func run(_ command: [String]) -> String? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: command[0])
        process.arguments = Array(command.dropFirst())
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        do { try process.run() } catch { return nil }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return String(data: data, encoding: .utf8)
    }
}
