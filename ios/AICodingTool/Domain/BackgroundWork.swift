import Foundation

/// How a thread's background work reads at a glance.
enum BackgroundWork {
    /// The live items counted by kind, as "2 subagents · 1 shell". Empty when nothing is live.
    static func summary(_ items: [MobileBackgroundItem]) -> String {
        let live = items.filter(\.live)
        return [("agent", "subagent"), ("workflow", "workflow"), ("shell", "shell"), ("monitor", "monitor")].compactMap { kind, noun in
            let count = live.filter { $0.kind == kind }.count
            return count == 0 ? nil : "\(count) \(noun)\(count == 1 ? "" : "s")"
        }.joined(separator: " · ")
    }

    static func symbol(_ kind: String) -> String {
        switch kind {
        case "agent": "sparkles"
        case "shell": "terminal"
        case "monitor": "dot.radiowaves.left.and.right"
        default: "square.stack.3d.up"
        }
    }
}
