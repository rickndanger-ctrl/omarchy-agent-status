#if canImport(AppKit)
import AppKit
import AgentStatusKit

/// The popup: LIVE AGENTS (one row per visible badge) and SOUNDS (a drop-down
/// per state). Same layout as BarWidget.qml's PopupCard.
public final class AgentStatusPanelView: NSView {
    public static let contentWidth: CGFloat = 340
    public var onSoundChange: ((AgentState, SoundName) -> Void)?

    private let stack = NSStackView()
    private let agentsStack = NSStackView()
    private var soundButtons: [AgentState: NSPopUpButton] = [:]
    private let captionFont = NSFont.systemFont(ofSize: 11)
    private let bodyFont = NSFont.systemFont(ofSize: 13)

    public override init(frame: NSRect) {
        super.init(frame: frame)
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 10
        stack.edgeInsets = NSEdgeInsets(top: 12, left: 14, bottom: 12, right: 14)
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor), stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.topAnchor.constraint(equalTo: topAnchor), stack.bottomAnchor.constraint(equalTo: bottomAnchor),
            widthAnchor.constraint(equalToConstant: Self.contentWidth),
        ])
        stack.addArrangedSubview(header("LIVE AGENTS"))
        agentsStack.orientation = .vertical
        agentsStack.alignment = .leading
        agentsStack.spacing = 6
        stack.addArrangedSubview(agentsStack)
        let separator = NSBox()
        separator.boxType = .separator
        stack.addArrangedSubview(separator)
        separator.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -28).isActive = true
        stack.addArrangedSubview(header("SOUNDS"))
        for state in AgentState.soundStates {
            let row = NSStackView()
            row.orientation = .horizontal
            row.spacing = 8
            let label = NSTextField(labelWithString: state.soundLabel)
            label.font = captionFont
            label.widthAnchor.constraint(equalToConstant: 95).isActive = true
            let button = NSPopUpButton(frame: .zero, pullsDown: false)
            button.addItems(withTitles: SoundName.allCases.map(\.rawValue))
            button.font = captionFont
            button.controlSize = .small
            button.target = self
            button.action = #selector(soundChanged(_:))
            button.tag = AgentState.soundStates.firstIndex(of: state) ?? 0
            button.widthAnchor.constraint(equalToConstant: Self.contentWidth - 28 - 95 - 8).isActive = true
            row.addArrangedSubview(label)
            row.addArrangedSubview(button)
            soundButtons[state] = button
            stack.addArrangedSubview(row)
        }
    }

    public required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    private func header(_ text: String) -> NSTextField {
        let label = NSTextField(labelWithString: text)
        label.font = NSFont.boldSystemFont(ofSize: 11)
        return label
    }

    public func apply(_ snapshot: Snapshot) {
        for view in agentsStack.arrangedSubviews { agentsStack.removeArrangedSubview(view); view.removeFromSuperview() }
        let visible = snapshot.visibleAgents
        if visible.isEmpty {
            let empty = NSTextField(labelWithString: "No agents reporting")
            empty.font = captionFont
            empty.textColor = .secondaryLabelColor
            agentsStack.addArrangedSubview(empty)
        }
        for badge in visible {
            let row = NSStackView()
            row.orientation = .horizontal
            row.spacing = 8
            let left = NSTextField(labelWithString: (badge.workspace.isEmpty ? "" : badge.workspace + " ") + badge.symbol + "  " + badge.name)
            left.font = bodyFont
            left.textColor = AgentStatusStyle.color(for: badge.state)
            left.widthAnchor.constraint(equalToConstant: 105).isActive = true
            let right = NSTextField(labelWithString: badge.page.isEmpty ? badge.state.rawValue : badge.page)
            right.font = captionFont
            right.lineBreakMode = .byTruncatingTail
            right.widthAnchor.constraint(equalToConstant: Self.contentWidth - 28 - 115).isActive = true
            row.addArrangedSubview(left)
            row.addArrangedSubview(right)
            agentsStack.addArrangedSubview(row)
        }
        for (state, button) in soundButtons {
            button.selectItem(withTitle: snapshot.sound(for: state).rawValue)
        }
    }

    @objc private func soundChanged(_ sender: NSPopUpButton) {
        guard AgentState.soundStates.indices.contains(sender.tag),
              let name = sender.titleOfSelectedItem.flatMap(SoundName.init(rawValue:)) else { return }
        onSoundChange?(AgentState.soundStates[sender.tag], name)
    }
}
#endif
