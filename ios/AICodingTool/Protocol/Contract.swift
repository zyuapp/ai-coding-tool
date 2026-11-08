import Foundation

// The phone's view of the computer, as `src/contracts/mobile.ts` describes it. Values the computer
// may extend in a newer build (statuses, engines, models, efforts, modes) are kept as strings, so
// an unknown one is shown as it was sent rather than failing the whole view.

struct MobileThreadEntry: Codable, Equatable, Identifiable, Sendable {
    var id: String
    var title: String
    var projectId: String?
    var projectName: String?
    var status: String
    var lastActivityAt: Double
    var unread: Bool
    var outcome: String?
    var headline: String?
    var waiting: Bool?
    var attention: Bool
}

struct MobileActivity: Codable, Equatable, Sendable {
    var priority: [MobileThreadEntry] = []
    var running: [MobileThreadEntry] = []
    var threads: [MobileThreadEntry] = []
    var snoozed: [MobileThreadEntry] = []
}

struct MobileProjectGroup: Codable, Equatable, Sendable {
    var projectId: String?
    var name: String
    var threads: [MobileThreadEntry]
}

struct MobileMessage: Codable, Equatable, Sendable {
    var kind: String
    var text: String
    var origin: String?
    var at: Double
    /// What a tool call did, read by the computer. Absent from older computers.
    var call: MobileToolCall?
    /// How many pictures the message carried.
    var images: Int?
}

/// A tool call as a row reads it: its label, and the argument that tells it from the next.
struct MobileToolCall: Codable, Equatable, Sendable {
    var family: String
    var label: String
    var argument: String
    var sigil: String?
    var verb: Bool?
}

/// A thread read without opening it, as a coordinator's tab shows one working under it.
struct MobileThreadRead: Codable, Equatable, Sendable {
    var title: String
    var status: String
    var messages: [MobileMessage]
    var omitted: Int
    var streamingTail: String?
}

/// A thread working under the open coordinator. `computer` names another computer holding it, which the phone cannot open.
struct MobileMember: Codable, Equatable, Identifiable, Sendable {
    var id: String
    var title: String
    var status: String
    var computer: String?
}

/// A workflow, process or subagent the open thread's session keeps going. Stop sends `run.stop-process` with its id.
struct MobileBackgroundItem: Codable, Equatable, Identifiable, Sendable {
    var id: String
    /// "agent", "shell", "monitor" or "workflow".
    var kind: String
    var title: String
    var detail: String
    /// "working", "idle", "completed", "failed" or "stopped".
    var status: String
    var live: Bool
    var stoppable: Bool
    var stopping: Bool?
}

struct MobileApproval: Codable, Equatable, Sendable {
    var taskId: String
    var from: String?
    var approvalId: String
    var runId: String
    var title: String
    var description: String
    var toolName: String
    var detail: String
}

struct QuestionOption: Codable, Equatable, Sendable {
    var label: String
    var description: String
}

struct PendingQuestion: Codable, Equatable, Sendable {
    var id: String
    var header: String
    var question: String
    var options: [QuestionOption]
    var runId: String
    var requestId: String
    var questionId: String
    var blocking: Bool
    var answer: String?
    var submitting: Bool?
}

struct MobileQueuedMessage: Codable, Equatable, Identifiable, Sendable {
    var id: String
    var text: String
    var origin: String?
    var steering: Bool?
}

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

struct MobileWorktreeChoice: Codable, Equatable, Identifiable, Sendable {
    var id: String
    var name: String
    var branch: String?
}

struct MobileChanges: Codable, Equatable, Sendable {
    var branch: String?
    var files: Int
    var additions: Int
    var deletions: Int
}

struct MobileThreadSettings: Codable, Equatable, Sendable {
    var engine: String
    var model: String?
    var effort: String
    var fastMode: Bool?
    var policy: String
    var coordinating: Bool?
}

struct MobileModel: Codable, Equatable, Sendable {
    var id: String
    var label: String
    var description: String
    var provider: String?
    var efforts: [String]
}

/// One piece of software on the computer, the app or an engine, and the command that moves it on, sent back as it came.
struct MobileUpkeepItem: Codable, Equatable, Sendable, Identifiable {
    struct Part: Codable, Equatable, Sendable {
        var text: String
        /// "live", "quiet", "progress", "offer" or "error".
        var tone: String?
    }

    struct Action: Codable, Equatable, Sendable {
        var label: String
        var command: PhoneCommand
    }

    var key: String
    var label: String
    var version: String?
    var state: Part
    var action: Action?
    var installing: Bool?

    var id: String { key }
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
}

struct MobileEngine: Codable, Equatable, Sendable {
    var access: String
    var models: [String]?
    var catalog: [MobileModel]?
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

struct MobileThreadView: Codable, Equatable, Sendable {
    var loading: Bool?
    var id: String
    var title: String
    var projectId: String?
    var projectName: String?
    var worktreeId: String?
    var messages: [MobileMessage]
    var omitted: Int
    var streamingTail: String?
    var status: String
    var approval: MobileApproval?
    var question: PendingQuestion?
    var queued: [MobileQueuedMessage]
    var settings: MobileThreadSettings
    var location: MobileLocation
    var worktrees: [MobileWorktreeChoice]
    var canMove: Bool
    var changes: MobileChanges?
    var reviewable: Bool
    var branchRange: DiffRange
    var members: [MobileMember]?
    var role: String?
    var background: [MobileBackgroundItem]?
}

struct MobileDraftView: Codable, Equatable, Sendable {
    var projectId: String?
    var projectName: String?
    var settings: MobileThreadSettings
    var worktree: Bool
    var worktreeName: String?
    var worktrees: [MobileWorktreeChoice]
    var canWorktree: Bool
}

struct MobileTheme: Codable, Equatable, Sendable {
    var dark: String
    var light: String
    var mode: String

    static let standard = MobileTheme(dark: "aicodingtool-dark", light: "aicodingtool-light", mode: "auto")
}

struct MobileView: Codable, Equatable, Sendable {
    var groups: [MobileProjectGroup]
    var activity: MobileActivity
    var theme: MobileTheme
    var engines: [String: MobileEngine]
    /// The computer's app, then its engines. Nil from a computer too old to be updated from the phone.
    var upkeep: [MobileUpkeepItem]?
    /// Whether the computer can turn a held recording into words now. Nil from a computer without dictation.
    var dictation: Bool? = nil
    var thread: MobileThreadView?
    var draft: MobileDraftView?
    var error: String?

    static let empty = MobileView(groups: [], activity: MobileActivity(), theme: MobileTheme(dark: "aicodingtool-dark", light: "aicodingtool-light", mode: "dark"), engines: [:], upkeep: nil, thread: nil, draft: nil, error: nil)
}

struct MobileEffortTerm: Codable, Equatable, Sendable {
    var id: String
    var label: String
    var description: String?
    var delegates: Bool?
}

struct MobilePolicyTerm: Codable, Equatable, Sendable {
    var id: String
    var label: String
    var description: String
}

struct MobileEngineTerms: Codable, Equatable, Sendable {
    var id: String
    var label: String
    var fastMode: Bool
    var policies: [MobilePolicyTerm]
    var models: [MobileModel]
}

/// What the computer's build calls its engines, modes, models and efforts.
struct MobileVocabulary: Codable, Equatable, Sendable {
    var engines: [MobileEngineTerms]
    var efforts: [MobileEffortTerm]
    var roles: [MobileRoleTerm]?
}

/// A role a thread may take, as the computer's build names it.
struct MobileRoleTerm: Codable, Equatable, Identifiable, Sendable {
    var id: String
    var label: String
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
