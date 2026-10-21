import Foundation

/// The six states the bar knows. Same names and meaning as `status.py`.
public enum AgentState: String, Codable, CaseIterable, Equatable {
    case working, done, attention, error, stopped, idle

    /// Blocking states win when one agent has several sessions (status.py PRIORITY).
    public var priority: Int {
        switch self {
        case .attention: return 5
        case .error: return 4
        case .working: return 3
        case .done: return 2
        case .stopped: return 1
        case .idle: return 0
        }
    }

    /// The glyph next to the icon (status.py SYMBOLS).
    public var symbol: String {
        switch self {
        case .done: return "✓"
        case .idle: return "○"
        default: return "●"
        }
    }

    /// Badge colour, the exact hex values the Omarchy widget uses (BarWidget.qml colorFor).
    public var colorHex: String {
        switch self {
        case .working, .done: return "#4ecb71"
        case .attention: return "#f5c84c"
        case .error, .stopped: return "#f16d6d"
        case .idle: return "#8b929d"
        }
    }

    /// Row labels in the SOUNDS section of the popup.
    public var soundLabel: String {
        switch self {
        case .working: return "Working"
        case .done: return "Done"
        case .attention: return "Needs you"
        case .stopped: return "Stopped"
        case .error: return "Problem"
        case .idle: return "Idle"
        }
    }

    /// States that can have a sound, in the order the popup lists them.
    public static let soundStates: [AgentState] = [.working, .done, .attention, .stopped, .error]
}

/// Sound choices, same names as the Linux widget so a copied config keeps working.
public enum SoundName: String, Codable, CaseIterable, Equatable {
    case off = "Off", complete = "Complete", bell = "Bell", message = "Message", warning = "Warning"

    /// The macOS system sound (NSSound name) that stands in for the freedesktop file.
    public var macSystemSound: String? {
        switch self {
        case .off: return nil
        case .complete: return "Glass"
        case .bell: return "Ping"
        case .message: return "Pop"
        case .warning: return "Basso"
        }
    }

    public static let defaults: [AgentState: SoundName] = [
        .working: .off, .done: .complete, .attention: .message, .stopped: .warning, .error: .warning,
    ]
}

/// One stored status event (status.py write_event). Only the state, a hashed
/// session id and a short project label are kept: no prompts, no paths.
public struct EventRecord: Codable, Equatable {
    public var agent: String
    public var session: String
    public var state: AgentState
    public var page: String
    public var source: String
    public var at: Double

    public init(agent: String, session: String, state: AgentState, page: String, source: String, at: Double) {
        self.agent = agent; self.session = session; self.state = state
        self.page = page; self.source = source; self.at = at
    }
}

/// What the bar draws for one agent (status.py collect() output, one entry).
public struct AgentBadge: Codable, Equatable {
    public var agent: String
    public var session: String
    public var state: AgentState
    public var page: String
    public var source: String
    public var at: Double
    public var visible: Bool
    public var name: String
    /// Absolute PNG path from the config, or "" to use the app icon / name.
    public var icon: String
    public var symbol: String
    /// Workspace (Linux) or page (OMAC) numbers, comma separated, "" when unknown.
    public var workspace: String
}

/// The poll() output the widget reads: agents by id, their order, and the sound choices.
public struct Snapshot: Codable, Equatable {
    public var agents: [String: AgentBadge]
    public var order: [String]
    public var sounds: [String: String]
    public var at: Double

    public init(agents: [String: AgentBadge], order: [String], sounds: [String: String], at: Double) {
        self.agents = agents; self.order = order; self.sounds = sounds; self.at = at
    }

    public static let empty = Snapshot(agents: [:], order: [], sounds: [:], at: 0)

    /// Badges in display order, only the ones the bar should show.
    public var visibleAgents: [AgentBadge] {
        order.compactMap { agents[$0] }.filter { $0.visible }
    }

    public func sound(for state: AgentState) -> SoundName {
        sounds[state.rawValue].flatMap(SoundName.init(rawValue:)) ?? SoundName.defaults[state] ?? .off
    }
}
