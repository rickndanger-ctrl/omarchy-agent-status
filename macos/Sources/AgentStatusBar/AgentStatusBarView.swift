#if canImport(AppKit)
import AppKit
import AgentStatusKit

/// Colours and icons shared by the bar and the popup.
public enum AgentStatusStyle {
    /// The bar badge: 17 pt icon, 3 pt gap, bold light + workspace number, 8 pt between badges.
    public static let iconSize: CGFloat = 17
    public static let innerSpacing: CGFloat = 3
    public static let badgeSpacing: CGFloat = 8
    public static let sidePadding: CGFloat = 6
    public static let lightFont = NSFont.boldSystemFont(ofSize: 13)
    public static let nameFont = NSFont.boldSystemFont(ofSize: 11)

    public static func color(hex: String) -> NSColor {
        var value: UInt64 = 0
        Scanner(string: String(hex.dropFirst())).scanHexInt64(&value)
        return NSColor(srgbRed: CGFloat((value >> 16) & 0xff) / 255, green: CGFloat((value >> 8) & 0xff) / 255,
                       blue: CGFloat(value & 0xff) / 255, alpha: 1)
    }

    public static func color(for state: AgentState) -> NSColor { color(hex: state.colorHex) }
}

/// Icon lookup: the config's PNG, else the installed app's icon, else the
/// original icon bundled with the widget, else nil (the name is shown instead).
public enum AgentIcons {
    private static var cache: [String: NSImage] = [:]
    static let bundleIDs: [String: [String]] = [
        "codex": ["com.openai.codex", "com.openai.chat"],
        "claude": ["com.anthropic.claudefordesktop"],
        "hermes": ["com.nousresearch.hermes.setup", "com.nousresearch.hermes"],
    ]
    static let bundledFiles: [String: String] = ["claude": "claude-icon", "herder": "herdr-icon"]

    public static func icon(for badge: AgentBadge) -> NSImage? {
        let key = badge.icon.isEmpty ? "agent:\(badge.agent)" : "file:\(badge.icon)"
        if let cached = cache[key] { return cached }
        var image: NSImage?
        if !badge.icon.isEmpty { image = NSImage(contentsOfFile: badge.icon) }
        if image == nil {
            for id in bundleIDs[badge.agent] ?? [] {
                if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: id) {
                    image = NSWorkspace.shared.icon(forFile: url.path)
                    break
                }
            }
        }
        if image == nil, let name = bundledFiles[badge.agent],
           let url = Bundle.module.url(forResource: name, withExtension: "png", subdirectory: "Icons") {
            image = NSImage(contentsOf: url)
        }
        if let image { cache[key] = image }
        return image
    }
}

/// One badge: icon (or name) + coloured light + workspace number.
public final class AgentBadgeView: NSView {
    private let iconView = NSImageView()
    private let nameLabel = NSTextField(labelWithString: "")
    private let lightLabel = NSTextField(labelWithString: "")

    public override init(frame: NSRect) {
        super.init(frame: frame)
        iconView.imageScaling = .scaleProportionallyUpOrDown
        nameLabel.font = AgentStatusStyle.nameFont
        lightLabel.font = AgentStatusStyle.lightFont
        for view in [iconView, nameLabel, lightLabel] as [NSView] { addSubview(view) }
    }

    public required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    public func apply(_ badge: AgentBadge, foreground: NSColor) {
        let icon = AgentIcons.icon(for: badge)
        iconView.image = icon
        iconView.isHidden = icon == nil
        nameLabel.stringValue = badge.name.isEmpty ? "?" : badge.name
        nameLabel.textColor = foreground
        nameLabel.isHidden = icon != nil
        lightLabel.stringValue = badge.symbol + (badge.workspace.isEmpty ? "" : " " + badge.workspace)
        lightLabel.textColor = AgentStatusStyle.color(for: badge.state)
        toolTip = "\(badge.name): \(badge.state.rawValue)" + (badge.page.isEmpty ? "" : " · \(badge.page)")
        setAccessibilityLabel("\(badge.name), \(badge.state.rawValue)" + (badge.workspace.isEmpty ? "" : ", workspace \(badge.workspace)"))
        layoutBadge()
    }

    private func layoutBadge() {
        let height = bounds.height
        var x: CGFloat = 0
        if !iconView.isHidden {
            iconView.frame = NSRect(x: 0, y: (height - AgentStatusStyle.iconSize) / 2, width: AgentStatusStyle.iconSize, height: AgentStatusStyle.iconSize)
            x = AgentStatusStyle.iconSize + AgentStatusStyle.innerSpacing
        } else {
            nameLabel.sizeToFit()
            nameLabel.frame.origin = NSPoint(x: 0, y: (height - nameLabel.frame.height) / 2)
            x = nameLabel.frame.width + AgentStatusStyle.innerSpacing
        }
        lightLabel.sizeToFit()
        lightLabel.frame.origin = NSPoint(x: x, y: (height - lightLabel.frame.height) / 2)
        frame.size.width = x + lightLabel.frame.width
    }

    public override func layout() { super.layout(); layoutBadge() }
}

/// The row of badges that sits in the bar (BarWidget.qml's `badges` Row).
/// Give it a height (the bar height) and call `apply` with each snapshot;
/// it sizes its own width, and is zero-width when no agent is visible.
public final class AgentStatusBarView: NSView {
    public var foreground: NSColor = .labelColor
    /// Called on a click anywhere on the badges (BarWidget toggles its popup).
    public var onClick: (() -> Void)?
    private var badges: [AgentBadgeView] = []

    public override init(frame: NSRect) {
        super.init(frame: frame)
        setAccessibilityRole(.group)
        setAccessibilityLabel("Agent status")
    }

    public required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    public func apply(_ snapshot: Snapshot) {
        let visible = snapshot.visibleAgents
        while badges.count > visible.count { badges.removeLast().removeFromSuperview() }
        while badges.count < visible.count {
            let badge = AgentBadgeView(frame: NSRect(x: 0, y: 0, width: 0, height: bounds.height))
            addSubview(badge)
            badges.append(badge)
        }
        var x = AgentStatusStyle.sidePadding
        for (view, badge) in zip(badges, visible) {
            view.frame = NSRect(x: x, y: 0, width: 0, height: bounds.height)
            view.apply(badge, foreground: foreground)
            x += view.frame.width + AgentStatusStyle.badgeSpacing
        }
        let width = visible.isEmpty ? 0 : x - AgentStatusStyle.badgeSpacing + AgentStatusStyle.sidePadding
        isHidden = visible.isEmpty
        frame.size.width = width
        invalidateIntrinsicContentSize()
        toolTip = visible.map { "\($0.name): \($0.state.rawValue)" }.joined(separator: "\n")
    }

    public override var intrinsicContentSize: NSSize { NSSize(width: frame.width, height: frame.height) }
    public override func mouseDown(with event: NSEvent) { onClick?() }
    public override func resetCursorRects() { addCursorRect(bounds, cursor: .pointingHand) }
}
#endif
