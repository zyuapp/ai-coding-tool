import Foundation

// How the phone words a thread.

enum TranscriptBlock: Equatable, Identifiable {
    case message(key: String, message: MobileMessage, answer: Bool)
    case tools(key: String, calls: [MobileMessage])

    var id: String {
        switch self {
        case .message(let key, _, _), .tools(let key, _): key
        }
    }
}

enum Format {
    /// A run of tool calls is one block; `answer` marks the assistant text that closes a turn.
    static func transcriptBlocks(_ messages: [MobileMessage]) -> [TranscriptBlock] {
        var blocks: [TranscriptBlock] = []
        var nextNonTool: [Int: MobileMessage?] = [:]
        var following: MobileMessage?
        for index in messages.indices.reversed() {
            nextNonTool[index] = following
            if messages[index].kind != "tool" { following = messages[index] }
        }
        for (index, message) in messages.enumerated() {
            let key = "\(index)-\(Int64(message.at))"
            if message.kind != "tool" {
                let next = nextNonTool[index] ?? nil
                blocks.append(.message(key: key, message: message, answer: message.kind == "assistant" && next?.kind != "assistant"))
                continue
            }
            if case .tools(let open, let calls) = blocks.last {
                blocks[blocks.count - 1] = .tools(key: open, calls: calls + [message])
            } else {
                blocks.append(.tools(key: key, calls: [message]))
            }
        }
        return blocks
    }

    /// The tools a run used, commonest first, counted where a tool was used more than once.
    static func summariseTools(_ calls: [MobileMessage]) -> String {
        var counts: [(String, Int)] = []
        for call in calls {
            let label = call.call?.label ?? ToolNames.label(call.text)
            if let index = counts.firstIndex(where: { $0.0 == label }) { counts[index].1 += 1 } else { counts.append((label, 1)) }
        }
        let sorted = counts.enumerated().sorted { left, right in
            left.element.1 != right.element.1 ? left.element.1 > right.element.1 : left.offset < right.offset
        }
        return sorted.map { $0.element.1 > 1 ? "\($0.element.0) ×\($0.element.1)" : $0.element.0 }.joined(separator: ", ")
    }

    static func statusLabel(_ status: String) -> String? {
        switch status {
        case "running": "Working"
        case "stopped": "Stopped"
        case "awaiting-approval": "Needs you"
        default: nil
        }
    }

    static func outcomeLabel(_ outcome: String) -> String? {
        switch outcome {
        case "finished": "Done"
        case "failed": "Failed"
        case "stopped": "Stopped"
        default: nil
        }
    }

    /// What the thread is doing and when it last moved.
    static func threadMeta(_ entry: MobileThreadEntry, now: Date) -> String {
        let when = relativeTime(entry.lastActivityAt, now: now)
        if entry.status != "idle", let label = statusLabel(entry.status) { return "\(label) · \(when)" }
        if let outcome = entry.outcome, let label = outcomeLabel(outcome) { return "\(label) · \(when)" }
        return when
    }

    static func activityMeta(_ entry: MobileThreadEntry, now: Date) -> String {
        "\(entry.projectName ?? "No project") · \(threadMeta(entry, now: now))"
    }

    static func locationLabel(_ location: MobileLocation) -> String {
        switch location {
        case .local: "Local"
        case .creating: "Creating worktree…"
        case .releasing: "Removing worktree…"
        case .worktree(let name, _): name
        }
    }

    static func changesLabel(_ changes: MobileChanges?) -> String? {
        guard let changes, changes.files > 0 else { return nil }
        return "\(changes.files) \(changes.files == 1 ? "file" : "files") · +\(changes.additions) −\(changes.deletions)"
    }

    enum GroupMark { case needsYou, unread }

    /// What a folded group still owes the eye: a thread waiting on the user, else one with news.
    static func groupMark(_ threads: [MobileThreadEntry]) -> GroupMark? {
        if threads.contains(where: { $0.status == "awaiting-approval" || $0.waiting == true }) { return .needsYou }
        if threads.contains(where: \.unread) { return .unread }
        return nil
    }

    /// Whether a tool's input reads at a glance: a few short lines, not a file.
    static func glanceable(_ detail: String) -> Bool {
        detail.utf16.count <= 400 && detail.split(separator: "\n", omittingEmptySubsequences: false).count <= 8
    }

    static func clockTime(_ at: Double) -> String {
        Date(timeIntervalSince1970: at / 1000).formatted(date: .omitted, time: .shortened)
    }

    /// How long ago, in as few characters as a row can spare.
    static func relativeTime(_ at: Double, now: Date) -> String {
        let gap = max(0, now.timeIntervalSince1970 * 1000 - at)
        let minute = 60_000.0, hour = 60 * minute, day = 24 * hour
        if gap < minute { return "now" }
        if gap < hour { return "\(Int(gap / minute))m" }
        if gap < day { return "\(Int(gap / hour))h" }
        if gap < 7 * day { return "\(Int(gap / day))d" }
        return Date(timeIntervalSince1970: at / 1000).formatted(.dateTime.month(.abbreviated).day())
    }

    static func archiveQuestion(_ title: String) -> String {
        "Archive “\(title.isEmpty ? "Untitled thread" : title)”?"
    }

    /// What archiving does, as the computer says it to a phone.
    static func archiveConsequence(running: Bool) -> String {
        "\(running ? "Its run stops and it" : "It") leaves the list. Restore it from Settings › Archived threads on your computer within 5 days."
    }
}

/// How well a name answers a query: the name starts with it, a word starts with it, or it is in there.
enum Matching {
    static func rank(_ name: String, _ wanted: String) -> Int? {
        let lower = name.lowercased()
        if lower.hasPrefix(wanted) { return 0 }
        if startsTitleWord(lower, wanted) { return 1 }
        return lower.contains(wanted) ? 2 : nil
    }

    static func startsTitleWord(_ lower: String, _ wanted: String) -> Bool {
        guard !wanted.isEmpty, wanted.unicodeScalars.allSatisfy({ ("a"..."z").contains($0) || ("0"..."9").contains($0) }) else { return false }
        let scalars = Array(lower.unicodeScalars)
        let target = Array(wanted.unicodeScalars)
        var atWordStart = true
        for index in scalars.indices {
            let scalar = scalars[index]
            let inWord = ("a"..."z").contains(scalar) || ("0"..."9").contains(scalar)
            if inWord, atWordStart, index + target.count <= scalars.count, Array(scalars[index..<(index + target.count)]) == target { return true }
            atWordStart = !inWord
        }
        return false
    }

    static func ranked<Item>(_ items: [Item], query: String, name: (Item) -> String) -> [Item] {
        let wanted = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard !wanted.isEmpty else { return items }
        var ranks: [[Item]] = [[], [], []]
        for item in items {
            if let rank = rank(name(item), wanted) { ranks[rank].append(item) }
        }
        return ranks.flatMap { $0 }
    }
}
