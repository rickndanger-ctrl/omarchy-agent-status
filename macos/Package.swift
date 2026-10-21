// swift-tools-version: 5.9
// Swift port of the Omarchy "Live Agent Status" bar widget (rickom1.agent-status).
// AgentStatusKit = the logic (Foundation only, builds on Linux too).
// AgentStatusBar = the AppKit badges row + popup panel.
// agent-status   = command-line bridge (same commands as status.py).
// AgentStatusDemo = menu-bar demo app showing the bar, for comparison.
import PackageDescription

let package = Package(
    name: "AgentStatus",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "AgentStatusKit", targets: ["AgentStatusKit"]),
        .library(name: "AgentStatusBar", targets: ["AgentStatusBar"]),
        .executable(name: "agent-status", targets: ["agent-status"]),
        .executable(name: "AgentStatusDemo", targets: ["AgentStatusDemo"]),
    ],
    targets: [
        .target(name: "AgentStatusKit"),
        .target(name: "AgentStatusBar", dependencies: ["AgentStatusKit"], resources: [.copy("Icons")]),
        .executableTarget(name: "agent-status", dependencies: ["AgentStatusKit"]),
        .executableTarget(name: "AgentStatusDemo", dependencies: ["AgentStatusKit", "AgentStatusBar"]),
        .testTarget(name: "AgentStatusKitTests", dependencies: ["AgentStatusKit"]),
    ]
)
