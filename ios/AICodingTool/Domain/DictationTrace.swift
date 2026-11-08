import Foundation

/// A guess at whether the system's dictation is filling the composer. iOS reports no dictation
/// state, but dictation adds words at a time while typing adds one character.
struct DictationTrace {
    /// How long after the last burst of words dictation may still be running.
    static let window: TimeInterval = 2

    private var lastBurst: Date?

    mutating func record(from old: String, to new: String, at now: Date = Date()) {
        if new.count - old.count > 1 { lastBurst = now }
    }

    func recent(at now: Date = Date()) -> Bool {
        guard let lastBurst else { return false }
        return now.timeIntervalSince(lastBurst) < Self.window
    }

    mutating func reset() { lastBurst = nil }
}
