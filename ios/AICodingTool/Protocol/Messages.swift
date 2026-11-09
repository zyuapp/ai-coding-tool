import Foundation

/// Bumped with `MOBILE_PROTOCOL_VERSION` in `src/contracts/mobile.ts`.
let mobileProtocolVersion = 8

/// The oldest computer this app reads. Raised only when an older computer would leave out what the app needs.
let oldestComputerProtocolVersion = 8

/// A field a patch may leave out, set, or set to null: absent and null mean different things.
enum PatchField<Value: Equatable & Sendable>: Equatable, Sendable {
    case absent
    case set(Value)

    func applied(to current: Value) -> Value {
        if case .set(let value) = self { return value }
        return current
    }
}

extension KeyedDecodingContainer {
    func patchField<T: Decodable & Equatable & Sendable>(_ type: T.Type, forKey key: Key) throws -> PatchField<T?> {
        guard contains(key) else { return .absent }
        if try decodeNil(forKey: key) { return .set(nil) }
        return .set(try decode(T.self, forKey: key))
    }

    func patchValue<T: Decodable & Equatable & Sendable>(_ type: T.Type, forKey key: Key) throws -> PatchField<T> {
        guard contains(key), try !decodeNil(forKey: key) else { return .absent }
        return .set(try decode(T.self, forKey: key))
    }
}

/// Everything about the open thread but which thread it is, so a change can name only what moved.
struct MobileThreadDelta: Decodable, Equatable, Sendable {
    struct Spliced: Decodable, Equatable, Sendable {
        var dropped: Int
        var kept: Int
        var messages: [MobileMessage]
    }

    struct Tail: Decodable, Equatable, Sendable {
        var from: Int
        var text: String
    }

    var loading: PatchField<Bool?> = .absent
    var title: PatchField<String> = .absent
    var projectId: PatchField<String?> = .absent
    var projectName: PatchField<String?> = .absent
    var worktreeId: PatchField<String?> = .absent
    var omitted: PatchField<Int> = .absent
    var streamingTail: PatchField<String?> = .absent
    var status: PatchField<String> = .absent
    var approval: PatchField<MobileApproval?> = .absent
    var question: PatchField<PendingQuestion?> = .absent
    var queued: PatchField<[MobileQueuedMessage]> = .absent
    var settings: PatchField<MobileThreadSettings> = .absent
    var location: PatchField<MobileLocation> = .absent
    var worktrees: PatchField<[MobileWorktreeChoice]> = .absent
    var canMove: PatchField<Bool> = .absent
    var changes: PatchField<MobileChanges?> = .absent
    var reviewable: PatchField<Bool> = .absent
    var branchRange: PatchField<DiffRange> = .absent
    var members: PatchField<[MobileMember]?> = .absent
    var role: PatchField<String?> = .absent
    var background: PatchField<[MobileBackgroundItem]?> = .absent
    var decisions: PatchField<[MobileDecision]?> = .absent
    var suggestions: PatchField<[MobileSuggestion]?> = .absent
    var limit: PatchField<MobileLimitPause?> = .absent
    var computer: PatchField<String?> = .absent
    var stoppable: PatchField<Bool?> = .absent
    var spliced: Spliced?
    var messages: [MobileMessage]?
    var tail: Tail?

    private enum CodingKeys: String, CodingKey {
        case loading, title, projectId, projectName, worktreeId, omitted, streamingTail, status, approval, question, queued, settings, location, worktrees, canMove, changes, reviewable, branchRange, members, role, background, decisions, suggestions, limit, computer, stoppable, spliced, messages, tail
    }

    init() {}

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        loading = try container.patchField(Bool.self, forKey: .loading)
        title = try container.patchValue(String.self, forKey: .title)
        projectId = try container.patchField(String.self, forKey: .projectId)
        projectName = try container.patchField(String.self, forKey: .projectName)
        worktreeId = try container.patchField(String.self, forKey: .worktreeId)
        omitted = try container.patchValue(Int.self, forKey: .omitted)
        streamingTail = try container.patchField(String.self, forKey: .streamingTail)
        status = try container.patchValue(String.self, forKey: .status)
        approval = try container.patchField(MobileApproval.self, forKey: .approval)
        question = try container.patchField(PendingQuestion.self, forKey: .question)
        queued = try container.patchValue([MobileQueuedMessage].self, forKey: .queued)
        settings = try container.patchValue(MobileThreadSettings.self, forKey: .settings)
        location = try container.patchValue(MobileLocation.self, forKey: .location)
        worktrees = try container.patchValue([MobileWorktreeChoice].self, forKey: .worktrees)
        canMove = try container.patchValue(Bool.self, forKey: .canMove)
        changes = try container.patchField(MobileChanges.self, forKey: .changes)
        reviewable = try container.patchValue(Bool.self, forKey: .reviewable)
        branchRange = try container.patchValue(DiffRange.self, forKey: .branchRange)
        members = try container.patchField([MobileMember].self, forKey: .members)
        role = try container.patchField(String.self, forKey: .role)
        background = try container.patchField([MobileBackgroundItem].self, forKey: .background)
        decisions = try container.patchField([MobileDecision].self, forKey: .decisions)
        suggestions = try container.patchField([MobileSuggestion].self, forKey: .suggestions)
        limit = try container.patchField(MobileLimitPause.self, forKey: .limit)
        computer = try container.patchField(String.self, forKey: .computer)
        stoppable = try container.patchField(Bool.self, forKey: .stoppable)
        spliced = try container.decodeIfPresent(Spliced.self, forKey: .spliced)
        messages = try container.decodeIfPresent([MobileMessage].self, forKey: .messages)
        tail = try container.decodeIfPresent(Tail.self, forKey: .tail)
    }
}

enum MobileThreadPatch: Decodable, Equatable, Sendable {
    case closed
    case opened(MobileThreadView)
    case changed(id: String, delta: MobileThreadDelta)

    private enum CodingKeys: String, CodingKey { case kind, thread, id, delta }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(String.self, forKey: .kind) {
        case "closed": self = .closed
        case "opened": self = .opened(try container.decode(MobileThreadView.self, forKey: .thread))
        case "changed": self = .changed(id: try container.decode(String.self, forKey: .id), delta: try container.decode(MobileThreadDelta.self, forKey: .delta))
        default: throw DecodingError.dataCorruptedError(forKey: .kind, in: container, debugDescription: "Unknown thread change")
        }
    }
}

/// What changed between two views.
struct MobilePatch: Decodable, Equatable, Sendable {
    var groups: [MobileProjectGroup]?
    var activity: MobileActivity?
    var theme: MobileTheme?
    var engines: [String: MobileEngine]?
    var upkeep: [MobileUpkeepItem]?
    var dictation: Bool?
    var usage: MobileUsage?
    var archived: Int?
    var thread: MobileThreadPatch?
    var draft: PatchField<MobileDraftView?> = .absent
    var error: PatchField<String?> = .absent

    private enum CodingKeys: String, CodingKey { case groups, activity, theme, engines, upkeep, dictation, usage, archived, thread, draft, error }

    init() {}

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        groups = try container.decodeIfPresent([MobileProjectGroup].self, forKey: .groups)
        activity = try container.decodeIfPresent(MobileActivity.self, forKey: .activity)
        theme = try container.decodeIfPresent(MobileTheme.self, forKey: .theme)
        engines = try container.decodeIfPresent([String: MobileEngine].self, forKey: .engines)
        upkeep = try container.decodeIfPresent([MobileUpkeepItem].self, forKey: .upkeep)
        dictation = try container.decodeIfPresent(Bool.self, forKey: .dictation)
        usage = try container.decodeIfPresent(MobileUsage.self, forKey: .usage)
        archived = try container.decodeIfPresent(Int.self, forKey: .archived)
        thread = try container.decodeIfPresent(MobileThreadPatch.self, forKey: .thread)
        draft = try container.patchField(MobileDraftView.self, forKey: .draft)
        error = try container.patchField(String.self, forKey: .error)
    }
}

extension MobileView {
    /// The view after `patch`, or nil when the patch does not fit the view it was meant for, which
    /// means a frame was lost and the phone must start over from a snapshot.
    func applying(_ patch: MobilePatch) -> MobileView? {
        var next = self
        if let groups = patch.groups { next.groups = groups }
        if let activity = patch.activity { next.activity = activity }
        if let theme = patch.theme { next.theme = theme }
        if let engines = patch.engines { next.engines = engines }
        if let upkeep = patch.upkeep { next.upkeep = upkeep }
        if let dictation = patch.dictation { next.dictation = dictation }
        if let usage = patch.usage { next.usage = usage }
        if let archived = patch.archived { next.archived = archived }
        next.draft = patch.draft.applied(to: draft)
        next.error = patch.error.applied(to: error)
        switch patch.thread {
        case nil: break
        case .closed: next.thread = nil
        case .opened(let thread): next.thread = thread
        case .changed(let id, let delta):
            guard let current = thread, current.id == id else { break }
            guard let changed = current.applying(delta) else { return nil }
            next.thread = changed
        }
        return next
    }
}

extension MobileThreadView {
    func applying(_ delta: MobileThreadDelta) -> MobileThreadView? {
        var next = self
        if let messages = delta.messages { next.messages = messages }
        if let spliced = delta.spliced {
            guard messages.count >= spliced.dropped + spliced.kept else { return nil }
            next.messages = Array(messages[spliced.dropped..<(spliced.dropped + spliced.kept)]) + spliced.messages
        }
        next.loading = delta.loading.applied(to: loading)
        next.title = delta.title.applied(to: title)
        next.projectId = delta.projectId.applied(to: projectId)
        next.projectName = delta.projectName.applied(to: projectName)
        next.worktreeId = delta.worktreeId.applied(to: worktreeId)
        next.omitted = delta.omitted.applied(to: omitted)
        next.streamingTail = delta.streamingTail.applied(to: streamingTail)
        next.status = delta.status.applied(to: status)
        next.approval = delta.approval.applied(to: approval)
        next.question = delta.question.applied(to: question)
        next.queued = delta.queued.applied(to: queued)
        next.settings = delta.settings.applied(to: settings)
        next.location = delta.location.applied(to: location)
        next.worktrees = delta.worktrees.applied(to: worktrees)
        next.canMove = delta.canMove.applied(to: canMove)
        next.changes = delta.changes.applied(to: changes)
        next.reviewable = delta.reviewable.applied(to: reviewable)
        next.branchRange = delta.branchRange.applied(to: branchRange)
        next.members = delta.members.applied(to: members)
        next.role = delta.role.applied(to: role)
        next.background = delta.background.applied(to: background)
        next.decisions = delta.decisions.applied(to: decisions)
        next.suggestions = delta.suggestions.applied(to: suggestions)
        next.limit = delta.limit.applied(to: limit)
        next.computer = delta.computer.applied(to: computer)
        next.stoppable = delta.stoppable.applied(to: stoppable)
        if let tail = delta.tail {
            // The server counts the tail in UTF-16 code units, as JavaScript strings do.
            guard streamingTail?.utf16.count == tail.from else { return nil }
            next.streamingTail = (streamingTail ?? "") + tail.text
        }
        return next
    }
}

/// Why the server refused. The code decides whether the phone retries.
enum MobileErrorCode: String, Sendable {
    case version, unauthorized, expiredCode = "expired-code", rateLimited = "rate-limited", unreadable, internalError = "internal"
}

enum MobileServerMessage: Equatable, Sendable {
    case paired(sequence: Int, deviceId: String, deviceName: String, token: String)
    /// `push` says the computer takes this phone's push token; older computers never say.
    case snapshot(sequence: Int, sessionId: String, view: MobileView, instance: String?, vocabulary: MobileVocabulary?, computer: String?, push: Bool = false)
    case patch(sequence: Int, patch: MobilePatch)
    case ack(sequence: Int, requestId: String, ok: Bool, message: String)
    case answer(sequence: Int, requestId: String, result: Result<JSONValue, AnswerError>)
    case error(sequence: Int, code: MobileErrorCode, message: String)
    case ping(sequence: Int, at: Double)

    struct AnswerError: Error, Equatable, Sendable {
        var message: String
    }

    var sequence: Int {
        switch self {
        case .paired(let sequence, _, _, _), .snapshot(let sequence, _, _, _, _, _, _), .patch(let sequence, _), .ack(let sequence, _, _, _), .answer(let sequence, _, _), .error(let sequence, _, _), .ping(let sequence, _):
            sequence
        }
    }
}

/// A frame as a message, or, for one this app cannot read, at least where it sat in the numbering.
func parseServerFrame(_ text: String) -> (message: MobileServerMessage?, sequence: Int?) {
    guard let data = text.data(using: .utf8), let root = try? JSONDecoder().decode(JSONValue.self, from: data), let object = root.objectValue else { return (nil, nil) }
    let sequence: Int? = {
        guard case .number(let value) = object["sequence"], value >= 0, value.rounded() == value else { return nil }
        return Int(value)
    }()
    guard let sequence, let kind = object["kind"]?.stringValue else { return (nil, nil) }
    let skipped: (MobileServerMessage?, Int?) = (nil, sequence > 0 ? sequence : nil)
    func string(_ key: String) -> String? { object[key]?.stringValue }
    do {
        switch kind {
        case "paired":
            guard let deviceId = string("deviceId"), let deviceName = string("deviceName"), let token = string("token") else { return skipped }
            return (.paired(sequence: sequence, deviceId: deviceId, deviceName: deviceName, token: token), sequence)
        case "snapshot":
            guard let sessionId = string("sessionId"), let view = object["view"] else { return skipped }
            let vocabulary = try? object["vocabulary"]?.decode(MobileVocabulary.self)
            return (.snapshot(sequence: sequence, sessionId: sessionId, view: try view.decode(MobileView.self), instance: string("instance"), vocabulary: vocabulary, computer: string("computer"), push: object["push"] == .bool(true)), sequence)
        case "patch":
            guard let patch = object["patch"] else { return skipped }
            return (.patch(sequence: sequence, patch: try patch.decode(MobilePatch.self)), sequence)
        case "ack":
            guard let requestId = string("requestId"), case .bool(let ok) = object["ok"] else { return skipped }
            return (.ack(sequence: sequence, requestId: requestId, ok: ok, message: string("message") ?? ""), sequence)
        case "answer":
            guard let requestId = string("requestId"), case .bool(let ok) = object["ok"] else { return skipped }
            let result: Result<JSONValue, MobileServerMessage.AnswerError> = ok ? .success(object["result"] ?? .null) : .failure(.init(message: string("message") ?? ""))
            return (.answer(sequence: sequence, requestId: requestId, result: result), sequence)
        case "error":
            guard let code = string("code").flatMap(MobileErrorCode.init(rawValue:)) else { return skipped }
            return (.error(sequence: sequence, code: code, message: string("message") ?? ""), sequence)
        case "ping":
            guard case .number(let at) = object["at"] else { return skipped }
            return (.ping(sequence: sequence, at: at), sequence)
        default:
            return skipped
        }
    } catch {
        return skipped
    }
}

/// What the phone sends.
/// Where this phone takes notices while the app is closed: its APNs token, and which APNs issued it.
struct PhonePush: Codable, Equatable, Sendable {
    enum Environment: String, Codable, Sendable {
        case production, sandbox
    }

    var token: String
    var environment: Environment
}

enum MobileClientMessage: Equatable, Sendable {
    case pair(code: String, deviceName: String)
    case resume(token: String, sessionId: String?, lastSequence: Int)
    case command(requestId: String, command: PhoneCommand)
    case query(requestId: String, query: JSONValue)
    case pong(at: Double)
    case ping(at: Double)
    case pushToken(PhonePush?)

    var json: JSONValue {
        switch self {
        case .pair(let code, let deviceName):
            .object(["kind": .string("pair"), "version": .number(Double(mobileProtocolVersion)), "oldestComputer": .number(Double(oldestComputerProtocolVersion)), "code": .string(code), "deviceName": .string(deviceName)])
        case .resume(let token, let sessionId, let lastSequence):
            {
                var object: [String: JSONValue] = ["kind": .string("resume"), "version": .number(Double(mobileProtocolVersion)), "oldestComputer": .number(Double(oldestComputerProtocolVersion)), "token": .string(token), "lastSequence": .number(Double(lastSequence))]
                if let sessionId { object["sessionId"] = .string(sessionId) }
                return .object(object)
            }()
        case .command(let requestId, let command):
            .object(["kind": .string("command"), "requestId": .string(requestId), "command": command.json])
        case .query(let requestId, let query):
            .object(["kind": .string("query"), "requestId": .string(requestId), "query": query])
        case .pong(let at): .object(["kind": .string("pong"), "at": .number(at)])
        case .ping(let at): .object(["kind": .string("ping"), "at": .number(at)])
        case .pushToken(let push):
            .object(["kind": .string("push-token"), "push": push.map { .object(["token": .string($0.token), "environment": .string($0.environment.rawValue)]) } ?? .null])
        }
    }

    var text: String {
        (try? String(decoding: JSONEncoder().encode(json), as: UTF8.self)) ?? "{}"
    }
}
