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

    var isMessage: Bool {
        if case .message = self { return true }
        return false
    }
}

enum Format {
    /// A run of tool calls is one block; `answer` marks the assistant text that closes a turn.
    /// `omitted` counts the messages before these, so a block keeps its key as the window slides.
    static func transcriptBlocks(_ messages: [MobileMessage], omitted: Int = 0) -> [TranscriptBlock] {
        var blocks: [TranscriptBlock] = []
        var nextNonTool: [Int: MobileMessage?] = [:]
        var following: MobileMessage?
        for index in messages.indices.reversed() {
            nextNonTool[index] = following
            if messages[index].kind != "tool" { following = messages[index] }
        }
        for (index, message) in messages.enumerated() {
            let key = "\(omitted + index)-\(Int64(message.at))"
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

    /// The last reply that closes a turn, which alone carries its time and copy button.
    static func latestAnswer(_ blocks: [TranscriptBlock]) -> String? {
        for block in blocks.reversed() {
            if case .message(let key, _, true) = block { return key }
        }
        return nil
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

    /// What the thread is doing, else how its last run ended.
    static func stateLabel(_ entry: MobileThreadEntry) -> String? {
        if entry.status != "idle", let label = statusLabel(entry.status) { return label }
        return entry.outcome.flatMap(outcomeLabel)
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

    /// When a plan window resets: a time today, or the day and time further out.
    static func usageReset(_ resetsAt: String?, now: Date, calendar: Calendar = .current) -> String? {
        guard let resetsAt, let at = instant(resetsAt) else { return nil }
        var style = Date.FormatStyle(date: .omitted, time: .shortened)
        style.timeZone = calendar.timeZone
        let time = at.formatted(style)
        if calendar.isDate(at, inSameDayAs: now) { return "Resets \(time)" }
        var day = Date.FormatStyle().month(.abbreviated).day()
        day.timeZone = calendar.timeZone
        return "Resets \(at.formatted(day)) at \(time)"
    }

    private static func instant(_ text: String) -> Date? {
        let plain = ISO8601DateFormatter()
        if let date = plain.date(from: text) { return date }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: text)
    }

    /// How long ago, in as few characters as a row can spare.
    /// A name cut in its middle to `limit` characters, which keeps the start and end that tell two long names apart.
    static func middleTruncated(_ text: String, limit: Int) -> String {
        guard text.count > limit, limit > 1 else { return text }
        let head = (limit - 1) / 2 + (limit - 1) % 2
        return "\(text.prefix(head))…\(text.suffix(limit - 1 - head))"
    }

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

    /// What archiving does, and where it is undone: here, from a computer that lists its archive to the phone.
    static func archiveConsequence(running: Bool, restorable: Bool) -> String {
        let back = restorable ? "Restore it from Archived within 5 days." : "Restore it from Settings › Archived threads on your computer within 5 days."
        return "\(running ? "Its run stops and it" : "It") leaves the list. \(back)"
    }

    /// A moment as a time today, or a weekday and time further out, as the desktop says when a limit lifts.
    static func liftTime(_ at: Double, now: Date, calendar: Calendar = .current) -> String {
        let date = Date(timeIntervalSince1970: at / 1000)
        var time = Date.FormatStyle(date: .omitted, time: .shortened)
        time.timeZone = calendar.timeZone
        if calendar.isDate(date, inSameDayAs: now) { return date.formatted(time) }
        var day = Date.FormatStyle().weekday(.abbreviated)
        day.timeZone = calendar.timeZone
        return "\(date.formatted(day)) \(date.formatted(time))"
    }

    /// What a paused thread says about its usage limit, as the desktop's limit row says it.
    static func limitLabel(_ pause: MobileLimitPause, now: Date, calendar: Calendar = .current) -> String {
        let waiting = now.timeIntervalSince1970 * 1000 < pause.resetsAt
        let lift = liftTime(pause.resetsAt, now: now, calendar: calendar)
        guard pause.resumesOnItsOwn else { return waiting ? "Weekly usage limit reached. Resets \(lift)." : "Weekly usage limit reset." }
        let ahead = (pause.position ?? 1) - 1
        let behind = ahead > 0 ? " after \(ahead) other \(ahead == 1 ? "thread" : "threads")" : ""
        return waiting ? "Usage limit reached. Resumes at \(lift)\(behind)." : "Usage limit reset. Resuming\(behind)."
    }

    /// How long an archived thread has before the computer deletes it, as the desktop's Archive page says it.
    static func deletesIn(_ deletesAt: Double, now: Date) -> String {
        let days = Int(((deletesAt - now.timeIntervalSince1970 * 1000) / 86_400_000).rounded(.up))
        if days <= 0 { return "Deletes on next launch" }
        return days == 1 ? "Deletes in 1 day" : "Deletes in \(days) days"
    }
}

/// How long Snooze puts a thread away for, as the desktop's thread menu offers it.
extension SnoozeOption: Identifiable {
    var id: Int { hours }
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
