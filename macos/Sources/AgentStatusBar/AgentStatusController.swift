#if canImport(AppKit)
import AppKit
import AgentStatusKit

public enum SoundPlayer {
    public static func play(_ name: SoundName) {
        guard let system = name.macSystemSound else { return }
        NSSound(named: system)?.play()
    }
}

/// Polls every 3 s (like the widget's Timer), feeds the bar view and the popup,
/// plays the sound for a state change, and stores sound choices.
/// Host apps that know where agents live (OMAC: pages) set `collector.workspaces`.
public final class AgentStatusController {
    public let collector: Collector
    public let barView: AgentStatusBarView
    public let panelView = AgentStatusPanelView(frame: .zero)
    public private(set) var snapshot: Snapshot = .empty
    public var onSnapshot: ((Snapshot) -> Void)?
    public var popupOpen: Bool { popover?.isShown ?? false }

    private var popover: NSPopover?
    private var timer: Timer?
    private let queue = DispatchQueue(label: "agent-status.poll", qos: .utility)
    private var polling = false

    public init(collector: Collector, barHeight: CGFloat = 22) {
        self.collector = collector
        barView = AgentStatusBarView(frame: NSRect(x: 0, y: 0, width: 0, height: barHeight))
        barView.onClick = { [weak self] in self?.togglePopup() }
        panelView.onSoundChange = { [weak self] state, name in
            guard let self else { return }
            try? AgentConfig.setSound(state, name, paths: self.collector.paths)
            SoundPlayer.play(name)
            var sounds = self.snapshot.sounds
            sounds[state.rawValue] = name.rawValue
            self.snapshot.sounds = sounds
            self.refresh()
        }
    }

    public func start(interval: TimeInterval = 3) {
        stop()
        let timer = Timer(timeInterval: interval, repeats: true) { [weak self] _ in self?.refresh() }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
        refresh()
    }

    public func stop() {
        timer?.invalidate()
        timer = nil
    }

    /// One poll off the main thread; the views update on the main thread.
    public func refresh() {
        guard !polling else { return }
        polling = true
        queue.async { [weak self] in
            guard let self else { return }
            let result = self.collector.poll()
            DispatchQueue.main.async {
                self.polling = false
                self.snapshot = result.snapshot
                self.barView.apply(result.snapshot)
                self.panelView.apply(result.snapshot)
                for name in result.sounds { SoundPlayer.play(name) }
                self.onSnapshot?(result.snapshot)
            }
        }
    }

    public func togglePopup() {
        if let popover, popover.isShown { popover.close(); return }
        let popover = self.popover ?? {
            let popover = NSPopover()
            popover.behavior = .transient
            let controller = NSViewController()
            controller.view = panelView
            popover.contentViewController = controller
            return popover
        }()
        self.popover = popover
        panelView.apply(snapshot)
        panelView.layoutSubtreeIfNeeded()
        popover.contentSize = panelView.fittingSize
        popover.show(relativeTo: barView.bounds, of: barView, preferredEdge: .minY)
    }
}
#endif
