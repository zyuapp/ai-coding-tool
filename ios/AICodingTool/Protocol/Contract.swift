import Foundation

// What the app derives from the generated records.

extension DiffRange {
    var key: String {
        switch self {
        case .uncommitted: "uncommitted"
        case .commit(let commit): "commit:\(commit)"
        case .branches(let base, let compare): "branches:\(base):\(compare ?? "")"
        }
    }
}

extension DiffFileSummary: Identifiable {
    var id: String { path }
    var fingerprint: String { "\(status):\(additions):\(deletions)" }
}

extension MobileThreadHistory {
    var end: Int { start + messages.count }
}

extension MobileMember {
    /// Whether the phone can open it: one on this computer, or one elsewhere whose computer is reachable.
    var openable: Bool { computer == nil || online == true }
}

extension MobileLimitPause {
    var resumesOnItsOwn: Bool { window == "session" }
}

extension MobileUpkeepItem: Identifiable {
    var id: String { key }
}

extension MobileEngineUsage: Identifiable {
    var id: String { engine }
}

extension MobileTheme {
    static let standard = MobileTheme(dark: "aicodingtool-dark", light: "aicodingtool-light", mode: "auto")
}

extension MobileView {
    /// The computer's software that wants the user: a newer version, one under way, or one that failed.
    var pendingUpkeep: [MobileUpkeepItem] {
        (upkeep ?? []).filter { $0.action != nil || ["offer", "progress", "error"].contains($0.state.tone) }
    }

    /// Whether any row offers a step that moves software on, which the computer chip marks.
    var updateOffered: Bool {
        (upkeep ?? []).contains { $0.action?.command.kind == .appUpdate || $0.action?.command.kind == .engineUpdate }
    }

    /// Whether the computer was installing its app update, which restarts it.
    var installingUpdate: Bool { upkeep?.contains { $0.installing == true } == true }

    static let empty = MobileView(groups: [], activity: MobileActivity(), theme: MobileTheme(dark: "aicodingtool-dark", light: "aicodingtool-light", mode: "dark"), engines: [:], upkeep: nil, thread: nil, draft: nil, error: nil)
}
