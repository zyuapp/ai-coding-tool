import Foundation

// What the phone reads from the computer that `Contract.generated.swift` cannot say: unions with a
// decoding of their own, and what the app derives from the generated records.

enum MobileLocation: Codable, Equatable, Sendable {
    case local
    case creating
    case releasing
    case worktree(name: String, threads: Int)

    private enum CodingKeys: String, CodingKey { case kind, name, threads }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(String.self, forKey: .kind) {
        case "creating": self = .creating
        case "releasing": self = .releasing
        case "worktree":
            self = .worktree(name: try container.decode(String.self, forKey: .name), threads: try container.decodeIfPresent(Int.self, forKey: .threads) ?? 1)
        default: self = .local
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .local: try container.encode("local", forKey: .kind)
        case .creating: try container.encode("creating", forKey: .kind)
        case .releasing: try container.encode("releasing", forKey: .kind)
        case .worktree(let name, let threads):
            try container.encode("worktree", forKey: .kind)
            try container.encode(name, forKey: .name)
            try container.encode(threads, forKey: .threads)
        }
    }
}

/// A comparison a review is read against.
enum DiffRange: Codable, Equatable, Hashable, Sendable {
    case uncommitted
    case commit(String)
    case branches(base: String, compare: String?)

    private enum CodingKeys: String, CodingKey { case kind, commit, base, compare }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(String.self, forKey: .kind) {
        case "commit": self = .commit(try container.decode(String.self, forKey: .commit))
        case "branches": self = .branches(base: try container.decode(String.self, forKey: .base), compare: try container.decodeIfPresent(String.self, forKey: .compare))
        default: self = .uncommitted
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .uncommitted: try container.encode("uncommitted", forKey: .kind)
        case .commit(let commit):
            try container.encode("commit", forKey: .kind)
            try container.encode(commit, forKey: .commit)
        case .branches(let base, let compare):
            try container.encode("branches", forKey: .kind)
            try container.encode(base, forKey: .base)
            if let compare { try container.encode(compare, forKey: .compare) } else { try container.encodeNil(forKey: .compare) }
        }
    }

    var key: String {
        switch self {
        case .uncommitted: "uncommitted"
        case .commit(let commit): "commit:\(commit)"
        case .branches(let base, let compare): "branches:\(base):\(compare ?? "")"
        }
    }

    var json: JSONValue {
        switch self {
        case .uncommitted: .object(["kind": .string("uncommitted")])
        case .commit(let commit): .object(["kind": .string("commit"), "commit": .string(commit)])
        case .branches(let base, let compare): .object(["kind": .string("branches"), "base": .string(base), "compare": compare.map(JSONValue.string) ?? .null])
        }
    }
}

/// What a comparison holds, as `DiffSummaryResult` says it.
struct DiffFileSummary: Codable, Equatable, Identifiable, Sendable {
    var path: String
    var previousPath: String?
    var status: String
    var additions: Int
    var deletions: Int
    var binary: Bool

    var id: String { path }
    var fingerprint: String { "\(status):\(additions):\(deletions)" }
}

enum DiffSummaryResult: Decodable, Equatable, Sendable {
    case available(range: DiffRange, files: [DiffFileSummary], additions: Int, deletions: Int)
    case unavailable(reason: String)
    case unknown
    case error(String)

    private enum CodingKeys: String, CodingKey { case status, range, files, additions, deletions, reason, message }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(String.self, forKey: .status) {
        case "available":
            self = .available(range: try container.decode(DiffRange.self, forKey: .range), files: try container.decode([DiffFileSummary].self, forKey: .files), additions: try container.decode(Int.self, forKey: .additions), deletions: try container.decode(Int.self, forKey: .deletions))
        case "unavailable": self = .unavailable(reason: try container.decode(String.self, forKey: .reason))
        case "unknown": self = .unknown
        default: self = .error(try container.decodeIfPresent(String.self, forKey: .message) ?? "The comparison could not be read.")
        }
    }
}

enum DiffPatchResult: Decodable, Equatable, Sendable {
    case available(String)
    case tooLarge
    case error(String)

    private enum CodingKeys: String, CodingKey { case status, patch, message }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(String.self, forKey: .status) {
        case "available": self = .available(try container.decode(String.self, forKey: .patch))
        case "too-large": self = .tooLarge
        default: self = .error(try container.decodeIfPresent(String.self, forKey: .message) ?? "The file could not be read.")
        }
    }
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
        (upkeep ?? []).contains { ["app.update", "engine.update"].contains($0.action?.command.type) }
    }

    /// Whether the computer was installing its app update, which restarts it.
    var installingUpdate: Bool { upkeep?.contains { $0.installing == true } == true }

    static let empty = MobileView(groups: [], activity: MobileActivity(), theme: MobileTheme(dark: "aicodingtool-dark", light: "aicodingtool-light", mode: "dark"), engines: [:], upkeep: nil, thread: nil, draft: nil, error: nil)
}
