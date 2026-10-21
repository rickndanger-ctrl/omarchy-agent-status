#if canImport(AppKit)
import AppKit
import AgentStatusKit
import AgentStatusBar

// Menu-bar demo: shows the badges row in a status item, click for the popup.
// Run with `swift run AgentStatusDemo`; quit with Control-C in the terminal.
final class Delegate: NSObject, NSApplicationDelegate {
    var item: NSStatusItem!
    var controller: AgentStatusController!

    func applicationDidFinishLaunching(_ notification: Notification) {
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        controller = AgentStatusController(collector: Collector(paths: .standard()), barHeight: item.button?.bounds.height ?? 22)
        guard let button = item.button else { return }
        let view = controller.barView
        view.autoresizingMask = [.height]
        button.addSubview(view)
        button.target = self
        button.action = #selector(clicked)
        controller.onSnapshot = { [weak self] snapshot in
            guard let self else { return }
            let width = view.frame.width
            self.item.length = max(width, 1)
            self.item.isVisible = width > 0
            // Keep the bar text empty: the badges draw themselves.
            button.title = ""
            button.toolTip = view.toolTip
            _ = snapshot
        }
        controller.start()
    }

    @objc func clicked() { controller.togglePopup() }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = Delegate()
app.delegate = delegate
app.run()
#else
print("AgentStatusDemo is a macOS menu-bar app; nothing to show on this platform.")
#endif
