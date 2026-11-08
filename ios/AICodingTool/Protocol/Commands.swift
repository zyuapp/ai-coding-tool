import Foundation

/// One command a paired phone may send, as `PhoneCommandType` in `src/contracts/workspace-view-input.ts`
/// lists them. The computer validates every field, so this only builds the shapes it accepts.
struct PhoneCommand: Codable, Equatable, Sendable {
    let json: JSONValue

    init(_ type: String, _ fields: [String: JSONValue?] = [:]) {
        var object: [String: JSONValue] = ["type": .string(type)]
        for (key, value) in fields {
            if let value { object[key] = value }
        }
        json = .object(object)
    }

    init(from decoder: Decoder) throws {
        let value = try JSONValue(from: decoder)
        guard value["type"]?.stringValue != nil else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "A command names its type"))
        }
        json = value
    }

    func encode(to encoder: Encoder) throws {
        try json.encode(to: encoder)
    }

    var type: String { json["type"]?.stringValue ?? "" }
    var taskId: String? { json["taskId"]?.stringValue }
    var text: String? { json["text"]?.stringValue }
    var questionId: String? { json["questionId"]?.stringValue }
}

private func jsonText(_ value: String?) -> JSONValue? { value.map(JSONValue.string) }
private func jsonFlag(_ value: Bool?) -> JSONValue? { value.map(JSONValue.bool) }

extension PhoneCommand {
    static func select(_ taskId: String) -> PhoneCommand { PhoneCommand("task.select", ["taskId": jsonText(taskId)]) }
    static func newThread(projectId: String?, worktreeId: String?) -> PhoneCommand { PhoneCommand("task.new", ["projectId": jsonText(projectId), "worktreeId": jsonText(worktreeId)]) }
    static func archive(_ taskId: String) -> PhoneCommand { PhoneCommand("task.archive", ["taskId": jsonText(taskId)]) }
    static func rename(_ taskId: String, title: String) -> PhoneCommand { PhoneCommand("task.rename", ["taskId": jsonText(taskId), "title": .string(title)]) }
    static func dismiss(_ taskId: String) -> PhoneCommand { PhoneCommand("task.dismiss", ["taskId": jsonText(taskId)]) }
    static func dismissAll(projectId: String?) -> PhoneCommand { PhoneCommand("task.dismiss-all", ["projectId": jsonText(projectId)]) }
    static func fork(_ taskId: String, worktree: Bool) -> PhoneCommand { PhoneCommand("task.fork", ["taskId": jsonText(taskId), "worktree": worktree ? .bool(true) : nil]) }
    static func setPolicy(_ taskId: String?, policy: String) -> PhoneCommand { PhoneCommand("task.set-policy", ["taskId": jsonText(taskId), "policy": .string(policy)]) }
    static func setModel(_ taskId: String?, engine: String, model: String?) -> PhoneCommand { PhoneCommand("task.set-model", ["taskId": jsonText(taskId), "engine": .string(engine), "model": jsonText(model)]) }
    static func setFastMode(_ taskId: String?, fastMode: Bool) -> PhoneCommand { PhoneCommand("task.set-fast-mode", ["taskId": jsonText(taskId), "fastMode": .bool(fastMode)]) }
    static func setEffort(_ taskId: String?, engine: String, effort: String) -> PhoneCommand { PhoneCommand("task.set-effort", ["taskId": jsonText(taskId), "engine": .string(engine), "effort": .string(effort)]) }
    static func setWorktree(_ worktree: Bool) -> PhoneCommand { PhoneCommand("task.set-worktree", ["worktree": .bool(worktree)]) }
    static func moveWorktree(_ taskId: String, destination: WorktreeDestination) -> PhoneCommand { PhoneCommand("task.move-worktree", ["taskId": jsonText(taskId), "destination": destination.json]) }
    static func send(_ taskId: String?, text body: String?, steer: Bool? = nil) -> PhoneCommand { PhoneCommand("task.send", ["taskId": jsonText(taskId), "text": jsonText(body), "steer": jsonFlag(steer)]) }
    static func steerQueued(_ taskId: String, messageId: String) -> PhoneCommand { PhoneCommand("task.steer-queued", ["taskId": jsonText(taskId), "messageId": .string(messageId)]) }
    static func dropQueued(_ taskId: String, messageId: String) -> PhoneCommand { PhoneCommand("task.drop-queued", ["taskId": jsonText(taskId), "messageId": .string(messageId)]) }
    static func cancel(_ taskId: String) -> PhoneCommand { PhoneCommand("run.cancel", ["taskId": jsonText(taskId)]) }
    static func decide(_ approval: MobileApproval, allow: Bool) -> PhoneCommand {
        PhoneCommand("run.decide", ["taskId": .string(approval.taskId), "runId": .string(approval.runId), "approvalId": .string(approval.approvalId), "allow": .bool(allow)])
    }
    static func answer(_ taskId: String, question: PendingQuestion, text answer: String) -> PhoneCommand {
        PhoneCommand("question.answer", ["taskId": .string(taskId), "runId": .string(question.runId), "requestId": .string(question.requestId), "questionId": .string(question.questionId), "text": .string(answer)])
    }
    /// Has the computer look for a newer app without a dialog, and read its engines' versions again.
    static let checkForUpdates = PhoneCommand("app.check-for-updates", ["quiet": .bool(true)])
    static let rereadEngines = PhoneCommand("engine.read", ["refresh": .bool(true)])
    static func setPrompt(_ prompt: String) -> PhoneCommand { PhoneCommand("view.set-prompt", ["prompt": .string(prompt)]) }
    /// Pictures, as data URLs, with the words that go with them, into a thread or the draft when `taskId` is nil.
    static func sendImages(_ taskId: String?, text: String, sources: [String], steer: Bool = false) -> PhoneCommand {
        let attachments = sources.map { JSONValue.object(["id": .string(UUID().uuidString.lowercased()), "source": .string($0), "annotations": .array([])]) }
        return PhoneCommand("attachments.send", ["taskId": jsonText(taskId), "text": text.isEmpty ? nil : .string(text), "attachments": .array(attachments), "steer": steer ? .bool(true) : nil])
    }
    /// A message with or without pictures: pictures go through the computer's attachment path, words alone as a plain send.
    static func message(_ taskId: String?, text: String, sources: [String], steer: Bool = false) -> PhoneCommand {
        sources.isEmpty ? .send(taskId, text: text, steer: steer ? true : nil) : .sendImages(taskId, text: text, sources: sources, steer: steer)
    }
    /// Makes a thread, or the draft when `taskId` is nil, a coordinator, or plain again.
    static func setCoordinator(_ taskId: String?, _ coordinating: Bool) -> PhoneCommand { PhoneCommand("task.set-role", ["taskId": jsonText(taskId), "role": coordinating ? JSONValue.string("coordinator") : JSONValue.null]) }
    /// Opens a folder on the computer as a project and starts a draft in it.
    static func addProject(_ root: String) -> PhoneCommand { PhoneCommand("project.add", ["root": .string(root), "start": .bool(true)]) }
}

/// Where a thread moves: the project's own checkout, an existing worktree, or a new one.
enum WorktreeDestination: Equatable, Sendable {
    case local
    case new
    case worktree(String)

    var json: JSONValue {
        switch self {
        case .local: .object(["kind": .string("local")])
        case .new: .object(["kind": .string("new")])
        case .worktree(let id): .object(["kind": .string("worktree"), "id": .string(id)])
        }
    }
}

/// What a phone reads that is content rather than state.
enum MobileQuery: Sendable {
    case diffSummary(taskId: String, range: DiffRange)
    case diffPatch(taskId: String, range: DiffRange, path: String, previousPath: String?)
    case directories(prefix: String)
    case thread(taskId: String)

    var json: JSONValue {
        switch self {
        case .diffSummary(let taskId, let range):
            .object(["kind": .string("diff-summary"), "taskId": .string(taskId), "range": range.json])
        case .directories(let prefix):
            .object(["kind": .string("directories"), "prefix": .string(prefix)])
        case .thread(let taskId):
            .object(["kind": .string("thread"), "taskId": .string(taskId)])
        case .diffPatch(let taskId, let range, let path, let previousPath):
            {
                var object: [String: JSONValue] = ["kind": .string("diff-patch"), "taskId": .string(taskId), "range": range.json, "path": .string(path)]
                if let previousPath { object["previousPath"] = .string(previousPath) }
                return .object(object)
            }()
        }
    }
}
