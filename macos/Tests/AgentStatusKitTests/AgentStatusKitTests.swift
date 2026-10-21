import Foundation
import XCTest
@testable import AgentStatusKit

final class AgentStatusKitTests: XCTestCase {
    var temp: URL!
    var paths: AgentStatusPaths!

    override func setUp() {
        temp = FileManager.default.temporaryDirectory.appendingPathComponent("agent-status-tests-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: temp, withIntermediateDirectories: true)
        paths = AgentStatusPaths.standard(environment: ["XDG_STATE_HOME": temp.path, "AGENT_STATUS_CONFIG": temp.appendingPathComponent("config.json").path], home: temp)
    }

    override func tearDown() { try? FileManager.default.removeItem(at: temp) }

    func testSHA256MatchesKnownVectors() {
        XCTAssertEqual(SHA256.hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
        XCTAssertEqual(SHA256.hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        // 56 bytes: forces a second padding block.
        XCTAssertEqual(SHA256.hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
                       "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1")
    }

    func testPathsFollowXDGStateHomeLikeTheLinuxBridge() {
        XCTAssertEqual(paths.events.path, temp.appendingPathComponent("omarchy/agent-status/events").path)
    }

    func testStoredEventKeepsOnlyLabelAndHashedSession() throws {
        let page = "/private/client name/研究 project"
        let session = "private-session-id"
        let parsed = try XCTUnwrap(StdinEvent.parse(Data("""
        {"agent": "hermes", "session": "\(session)", "state": "attention", "page": "\(page)"}
        """.utf8)))
        XCTAssertNotNil(EventStore.writeEvent(agent: parsed.agent, session: parsed.session, state: parsed.state, page: parsed.page, paths: paths))
        let files = try FileManager.default.contentsOfDirectory(at: paths.events.appendingPathComponent("hermes"), includingPropertiesForKeys: nil)
        XCTAssertEqual(files.count, 1)
        let text = try String(contentsOf: files[0], encoding: .utf8)
        let record = try XCTUnwrap(JSONFile.decode(EventRecord.self, from: files[0]))
        XCTAssertEqual(record.page, "研究 project")
        XCTAssertEqual(record.state, .attention)
        XCTAssertEqual(record.session, String(SHA256.hex(session).prefix(20)))
        XCTAssertFalse(text.contains(page))
        XCTAssertFalse(text.contains(session))
    }

    func testInvalidStdinInputIsRejected() {
        for payload in ["private malformed input", "[]", "{\"agent\":\"hermes\"}",
                        "{\"agent\":\"hermes\",\"session\":{},\"state\":\"done\"}",
                        "{\"agent\":\"hermes\",\"session\":\"s\",\"state\":\"done\",\"page\":[]}"] {
            XCTAssertNil(StdinEvent.parse(Data(payload.utf8)), payload)
        }
    }

    func testUnknownAgentOrStateIsDropped() {
        XCTAssertNil(EventStore.writeEvent(agent: "stranger", session: "s", state: .done, paths: paths))
        XCTAssertNil(EventStore.writeEvent(agent: "herder", session: "s", state: "dancing", paths: paths))
        XCTAssertFalse(FileManager.default.fileExists(atPath: paths.events.path))
    }

    func testPositionalEventCommandStaysCompatible() throws {
        XCTAssertNotNil(EventStore.writeEvent(agent: "herder", session: "session", state: "working", page: "project-label", paths: paths))
        let files = try FileManager.default.contentsOfDirectory(at: paths.events.appendingPathComponent("herder"), includingPropertiesForKeys: nil)
        XCTAssertEqual(JSONFile.decode(EventRecord.self, from: files[0])?.page, "project-label")
    }

    func testLabelTakesLastComponentCappedAt32() {
        XCTAssertEqual(EventStore.label(for: "/home/rick/Projects/omarchy-agent-status/"), "omarchy-agent-status")
        XCTAssertEqual(EventStore.label(for: String(repeating: "x", count: 40)).count, 32)
        XCTAssertEqual(EventStore.label(for: ""), "")
    }

    func testClaudeHookMapping() {
        XCTAssertEqual(ClaudeHook.state(forEvent: "UserPromptSubmit", notificationType: nil), .working)
        XCTAssertEqual(ClaudeHook.state(forEvent: "PreToolUse", notificationType: nil), .working)
        XCTAssertEqual(ClaudeHook.state(forEvent: "Stop", notificationType: nil), .done)
        XCTAssertEqual(ClaudeHook.state(forEvent: "SessionEnd", notificationType: nil), .stopped)
        XCTAssertEqual(ClaudeHook.state(forEvent: "PermissionRequest", notificationType: nil), .attention)
        XCTAssertEqual(ClaudeHook.state(forEvent: "Notification", notificationType: "permission_prompt"), .attention)
        XCTAssertNil(ClaudeHook.state(forEvent: "Notification", notificationType: "idle_prompt"))
        XCTAssertNil(ClaudeHook.state(forEvent: "SubagentStop", notificationType: nil))
        let result = ClaudeHook.interpret(eventName: "Stop", payload: Data("{\"session_id\":\"abc\",\"cwd\":\"/x/y/proj\"}".utf8))
        XCTAssertEqual(result?.session, "abc")
        XCTAssertEqual(result?.page, "/x/y/proj")
        XCTAssertEqual(result?.state, .done)
    }

    func testCodexRolloutParsing() throws {
        let home = temp.appendingPathComponent("home")
        let folder = home.appendingPathComponent(".codex/sessions/2026/10/21")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let file = folder.appendingPathComponent("rollout-2026-10-21T14-05-20-abc.jsonl")
        let lines = [
            "{\"type\":\"session_meta\",\"payload\":{\"cwd\":\"/Users/rick/Documents/Codex/2026-09-22/omac\"}}",
            "{\"type\":\"turn_context\",\"payload\":{\"cwd\":\"/Users/rick/Projects/omac-native\"}}",
            "{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_started\"}}",
            "{\"type\":\"response_item\",\"payload\":{\"text\":\"private prompt text\"}}",
            "{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_complete\"}}",
            "{\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\"}}",
        ]
        try (lines.joined(separator: "\n") + "\n").write(to: file, atomically: true, encoding: .utf8)
        let records = CodexSessions.scan(home: home, now: Date())
        XCTAssertEqual(records.count, 1)
        XCTAssertEqual(records[0].state, .done)
        XCTAssertEqual(records[0].page, "omac-native")
        XCTAssertEqual(records[0].session, "rollout-2026-10-21T14-05-20-abc")
        // Without a turn_context the first line's folder is used; the Codex app's own folder gets a generic label.
        let second = folder.appendingPathComponent("rollout-2026-10-21T15-00-00-def.jsonl")
        try "{\"type\":\"session_meta\",\"payload\":{\"cwd\":\"/Users/rick/Documents/Codex/2026-09-22/omac\"}}\n{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_started\"}}\n".write(to: second, atomically: true, encoding: .utf8)
        let again = CodexSessions.scan(home: home, now: Date())
        XCTAssertEqual(again.count, 2)
        let working = try XCTUnwrap(again.first { $0.session.hasSuffix("def") })
        XCTAssertEqual(working.state, .working)
        XCTAssertEqual(working.page, "Codex task")
        // A session untouched for over an hour must not stay "working".
        let stale = CodexSessions.scan(home: home, now: Date().addingTimeInterval(2 * 3600))
        XCTAssertEqual(stale.first { $0.session.hasSuffix("def") }?.state, .stopped)
        // A week-old file is ignored entirely.
        XCTAssertTrue(CodexSessions.scan(home: home, now: Date().addingTimeInterval(8 * 86400)).isEmpty)
    }

    func testCollectPrefersBlockingStateAndMarksVisibility() {
        let now = Date()
        let collector = Collector(paths: paths, workspaces: { $0.id == "claude" ? [3, 1] : [] },
                                  runningAgents: { ["hermes"] }, codexSessions: { _ in [] }, now: { now })
        EventStore.writeEvent(agent: "claude", session: "a", state: .working, page: "/p/newer", paths: paths, now: now)
        EventStore.writeEvent(agent: "claude", session: "b", state: .attention, page: "/p/older", paths: paths, now: now.addingTimeInterval(-600))
        let badges = Dictionary(uniqueKeysWithValues: collector.collect().map { ($0.id, $0.badge) })
        XCTAssertEqual(badges["claude"]?.state, .attention)
        XCTAssertEqual(badges["claude"]?.page, "older")
        XCTAssertEqual(badges["claude"]?.workspace, "1,3")
        XCTAssertEqual(badges["claude"]?.visible, true)
        XCTAssertEqual(badges["hermes"]?.state, .idle)
        XCTAssertEqual(badges["hermes"]?.visible, true, "a running app keeps its badge")
        XCTAssertEqual(badges["herder"]?.visible, true, "Herdr shows while idle")
        XCTAssertEqual(badges["codex"]?.visible, false)
        XCTAssertEqual(collector.collect().map(\.id), ["codex", "claude", "hermes", "herder"])
    }

    func testCustomAgentFromConfigAndOverride() throws {
        try """
        {"agents": [{"id": "scout", "name": "Scout", "windowMatch": "Scout", "showIdle": false},
                    {"id": "claude", "name": "CC"}, {"id": "Bad Id"}]}
        """.write(to: paths.config, atomically: true, encoding: .utf8)
        let definitions = AgentConfig.definitions(paths: paths)
        XCTAssertEqual(definitions.map(\.id), ["codex", "claude", "hermes", "herder", "scout"])
        XCTAssertEqual(definitions[1].name, "CC")
        XCTAssertEqual(definitions[4].windowMatch, ["scout"])
        XCTAssertFalse(definitions[4].showIdle)
        XCTAssertNotNil(EventStore.writeEvent(agent: "scout", session: "s", state: .done, paths: paths))
    }

    func testPollPlaysSoundOnlyWhenStateChanges() throws {
        var state = AgentState.working
        let collector = Collector(paths: paths, runningAgents: { [] },
                                  codexSessions: { now in [EventRecord(agent: "codex", session: "x", state: state, page: "p", source: "session", at: now.timeIntervalSince1970)] })
        let first = collector.poll()
        XCTAssertEqual(first.sounds, [], "the first snapshot has nothing to compare with")
        XCTAssertEqual(first.snapshot.visibleAgents.map(\.name), ["Codex", "Herdr"])
        XCTAssertEqual(collector.poll().sounds, [])
        state = .done
        XCTAssertEqual(collector.poll().sounds, [.complete])
        try AgentConfig.setSound(.attention, .bell, paths: paths)
        state = .attention
        let third = collector.poll()
        XCTAssertEqual(third.sounds, [.bell])
        XCTAssertEqual(third.snapshot.sound(for: .attention), .bell)
        XCTAssertEqual(third.snapshot.sound(for: .done), .complete)
        XCTAssertNotNil(JSONFile.decode(Snapshot.self, from: paths.snapshot))
    }

    func testProcessNamesFromMacAndLinuxPS() {
        XCTAssertEqual(ProcessScan.agents(fromCommandNames: ["/Applications/Codex.app/Contents/MacOS/Codex", "claude", "/usr/bin/zsh", " hermes "]),
                       ["codex", "claude", "hermes"])
        XCTAssertEqual(ProcessScan.agents(fromCommandNames: ["chatgpt"]), ["codex"])
    }
}
