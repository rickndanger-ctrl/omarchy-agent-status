import Foundation

/// Builds the snapshot the bar draws (status.py collect() and poll()).
///
/// Workspace numbers: on Linux they come from Hyprland. On macOS the host app
/// supplies them through `workspaces` (OMAC: the page each agent's terminal is
/// tiled on). The default reports none, so badges show icon + light only.
public final class Collector {
    public let paths: AgentStatusPaths
    public var workspaces: (AgentDefinition) -> [Int]
    public var runningAgents: () -> Set<String>
    public var codexSessions: (Date) -> [EventRecord]
    public var now: () -> Date

    public init(paths: AgentStatusPaths,
                workspaces: @escaping (AgentDefinition) -> [Int] = { _ in [] },
                runningAgents: @escaping () -> Set<String> = { ProcessScan.activeAgents() },
                codexSessions: @escaping (Date) -> [EventRecord] = { CodexSessions.scan(now: $0) },
                now: @escaping () -> Date = { Date() }) {
        self.paths = paths
        self.workspaces = workspaces
        self.runningAgents = runningAgents
        self.codexSessions = codexSessions
        self.now = now
    }

    /// One badge per agent, in display order.
    public func collect() -> [(id: String, badge: AgentBadge)] {
        let now = now().timeIntervalSince1970
        let definitions = AgentConfig.definitions(paths: paths)
        var items = codexSessions(Date(timeIntervalSince1970: now))
        items += EventStore.recentEvents(paths: paths, definitions: definitions, now: Date(timeIntervalSince1970: now))
        let running = runningAgents()
        return definitions.map { definition in
            let pool = items.filter { $0.agent == definition.id && now - $0.at < 3600 }
            var chosen: EventRecord
            if let best = pool.max(by: { ($0.state.priority, $0.at) < ($1.state.priority, $1.at) }) {
                // Attend to blocking states first; otherwise show the newest session.
                chosen = best
                if chosen.state == .working, now - chosen.at > 3600 { chosen.state = .stopped }
            } else {
                chosen = EventRecord(agent: definition.id, session: "", state: .idle, page: "", source: "", at: 0)
            }
            let age = now - chosen.at
            let visible = definition.showIdle || running.contains(definition.id)
                || ([.done, .attention, .error, .stopped].contains(chosen.state) && age < 3600)
                || (chosen.state == .working && age < 3600)
            let numbers = workspaces(definition).sorted().map(String.init).joined(separator: ",")
            let badge = AgentBadge(agent: chosen.agent, session: chosen.session, state: chosen.state, page: chosen.page,
                                   source: chosen.source, at: chosen.at, visible: visible, name: definition.name,
                                   icon: definition.icon, symbol: chosen.state.symbol, workspace: numbers)
            return (definition.id, badge)
        }
    }

    /// Collect, compare with the last snapshot, store the new one. Returns the snapshot
    /// and the sounds to play for every agent whose state changed.
    public func poll() -> (snapshot: Snapshot, sounds: [SoundName]) {
        let previous = JSONFile.decode(Snapshot.self, from: paths.snapshot) ?? .empty
        let config = JSONFile.readObject(paths.config)
        let sounds = AgentConfig.sounds(config: config)
        let selected = collect()
        var toPlay: [SoundName] = []
        for (id, badge) in selected {
            guard let prior = previous.agents[id], prior.state != badge.state,
                  let name = sounds[badge.state.rawValue].flatMap(SoundName.init(rawValue:)), name != .off else { continue }
            toPlay.append(name)
        }
        let snapshot = Snapshot(agents: Dictionary(uniqueKeysWithValues: selected.map { ($0.id, $0.badge) }),
                                order: selected.map(\.id), sounds: sounds, at: now().timeIntervalSince1970)
        try? JSONFile.write(snapshot, to: paths.snapshot)
        return (snapshot, toPlay)
    }
}
