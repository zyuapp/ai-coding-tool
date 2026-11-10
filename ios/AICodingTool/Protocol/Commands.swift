import Foundation

/// One command a paired phone may send, as `MobileCommand` in `src/contracts/mobile.ts` names them.
/// The computer validates every field, so this only builds the shapes it accepts.
struct PhoneCommand: Codable, Equatable, Sendable {
    let json: JSONValue

    init(_ type: String, _ fields: [String: JSONValue?] = [:]) {
        var object: [String: JSONValue] = ["type": .string(type)]
        for (key, value) in fields {
            if let value { object[key] = value }
        }
        json = .object(object)
    }

    init(_ kind: Kind, _ fields: [String: JSONValue?] = [:]) {
        self.init(kind.rawValue, fields)
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
    /// Nil for a command a newer computer offers that this app does not know.
    var kind: Kind? { Kind(rawValue: type) }
    var taskId: String? { json["taskId"]?.stringValue }
    var text: String? { json["text"]?.stringValue }
    var questionId: String? { json["questionId"]?.stringValue }
}

extension PhoneCommand {
    static func select(_ taskId: String) -> PhoneCommand { .taskSelect(taskId: taskId) }
    static func newThread(projectId: String?, worktreeId: String?) -> PhoneCommand { .taskNew(projectId: projectId, worktreeId: worktreeId) }
    static func archive(_ taskId: String) -> PhoneCommand { .taskArchive(taskId: taskId) }
    static func rename(_ taskId: String, title: String) -> PhoneCommand { .taskRename(taskId: taskId, title: title) }
    static func dismiss(_ taskId: String) -> PhoneCommand { .taskDismiss(taskId: taskId) }
    static func dismissAll(projectId: String?) -> PhoneCommand { .taskDismissAll(projectId: projectId) }
    static func fork(_ taskId: String, worktree: Bool) -> PhoneCommand { .taskFork(taskId: taskId, worktree: worktree ? true : nil) }
    static func setPolicy(_ taskId: String?, policy: String) -> PhoneCommand { .taskSetPolicy(taskId: taskId, policy: policy) }
    static func setModel(_ taskId: String?, engine: String, model: String?) -> PhoneCommand { .taskSetModel(taskId: taskId, engine: engine, model: model) }
    static func setFastMode(_ taskId: String?, fastMode: Bool) -> PhoneCommand { .taskSetFastMode(taskId: taskId, fastMode: fastMode) }
    static func setEffort(_ taskId: String?, engine: String, effort: String) -> PhoneCommand { .taskSetEffort(taskId: taskId, engine: engine, effort: effort) }
    static func setWorktree(_ worktree: Bool) -> PhoneCommand { .taskSetWorktree(worktree: worktree) }
    static func moveWorktree(_ taskId: String, destination: WorktreeDestination) -> PhoneCommand { .taskMoveWorktree(taskId: taskId, destination: destination) }
    static func send(_ taskId: String?, text body: String?, steer: Bool? = nil) -> PhoneCommand { .taskSend(taskId: taskId, text: body, steer: steer) }
    static func steerQueued(_ taskId: String, messageId: String) -> PhoneCommand { .taskSteerQueued(taskId: taskId, messageId: messageId) }
    static func dropQueued(_ taskId: String, messageId: String) -> PhoneCommand { .taskDropQueued(taskId: taskId, messageId: messageId) }
    /// Takes a queued message out of the queue so its words come back to this phone's composer.
    static func editQueued(_ taskId: String, messageId: String) -> PhoneCommand { .taskEditQueued(taskId: taskId, messageId: messageId) }
    /// Stops a coordinator and everything working under it.
    static func stopAll(_ taskId: String) -> PhoneCommand { .coordinationStopAll(taskId: taskId) }
    static func cancel(_ taskId: String) -> PhoneCommand { .runCancel(taskId: taskId) }
    /// Ends one workflow, process or subagent without ending the run.
    static func stopProcess(_ taskId: String, processId: String) -> PhoneCommand { .runStopProcess(taskId: taskId, processId: processId) }
    static func decide(_ approval: MobileApproval, allow: Bool) -> PhoneCommand {
        .runDecide(allow: allow, taskId: approval.taskId, runId: approval.runId, approvalId: approval.approvalId)
    }
    static func answer(_ taskId: String, question: PendingQuestion, text answer: String) -> PhoneCommand {
        .questionAnswer(taskId: taskId, runId: question.runId, requestId: question.requestId, questionId: question.questionId, text: answer)
    }
    static func answerDecision(_ decision: MobileDecision, answer: String) -> PhoneCommand { .decisionAnswer(taskId: decision.taskId, decisionId: decision.id, answer: answer) }
    static func startSuggestion(_ coordinatorId: String, proposalId: String) -> PhoneCommand { .proposalStart(taskId: coordinatorId, proposalId: proposalId) }
    static func resumeLimit(_ taskId: String) -> PhoneCommand { .limitResume(taskId: taskId) }
    static func cancelLimit(_ taskId: String) -> PhoneCommand { .limitCancel(taskId: taskId) }
    static func snooze(_ taskId: String, hours: Int) -> PhoneCommand { .taskSnooze(taskId: taskId, hours: hours) }
    static func unsnooze(_ taskId: String) -> PhoneCommand { .taskUnsnooze(taskId: taskId) }
    static func restore(_ taskId: String) -> PhoneCommand { .taskRestore(taskId: taskId) }
    /// Has the computer look for a newer app without a dialog, and read its engines' versions again.
    static let checkForUpdates = PhoneCommand.appCheckForUpdates(quiet: true)
    static let readUsage = PhoneCommand.usageRead()
    static func dismissUsageWarning(_ key: String) -> PhoneCommand { .usageDismissWarning(warning: key) }
    static let rereadEngines = PhoneCommand.engineRead(refresh: true)
    static func setPrompt(_ prompt: String) -> PhoneCommand { .viewSetPrompt(prompt: prompt) }
    /// Pictures, as data URLs, with the words that go with them, into a thread or the draft when `taskId` is nil.
    static func sendImages(_ taskId: String?, text: String, sources: [String], steer: Bool = false) -> PhoneCommand {
        let attachments = sources.map { OutgoingAttachment(id: UUID().uuidString.lowercased(), source: $0, annotations: []) }
        return .attachmentsSend(taskId: taskId, steer: steer ? true : nil, attachments: attachments, text: text.isEmpty ? nil : text)
    }
    /// A message with or without pictures: pictures go through the computer's attachment path, words alone as a plain send.
    static func message(_ taskId: String?, text: String, sources: [String], steer: Bool = false) -> PhoneCommand {
        sources.isEmpty ? .send(taskId, text: text, steer: steer ? true : nil) : .sendImages(taskId, text: text, sources: sources, steer: steer)
    }
    /// Makes a thread, or the draft when `taskId` is nil, a coordinator, or plain again.
    static func setCoordinator(_ taskId: String?, _ coordinating: Bool) -> PhoneCommand { setRole(taskId, role: coordinating ? "coordinator" : nil) }
    /// Gives a thread, or the draft when `taskId` is nil, a role, or takes its role away.
    static func setRole(_ taskId: String?, role: String?) -> PhoneCommand { .taskSetRole(taskId: taskId, role: role) }
    /// Opens a folder on the computer as a project and starts a draft in it.
    static func addProject(_ root: String) -> PhoneCommand { .projectAdd(root: root, start: true) }
}

extension MobileQuery {
    /// How long the computer may take. A recording waits out the computer's own limit, which covers
    /// loading its speech model and writing down two minutes of speech.
    var timeout: Duration {
        if case .transcribe = self { return .seconds(135) }
        if case .image = self { return .seconds(30) }
        /// Codex starts a server to list its skills, which the computer gives twenty seconds.
        if case .commands = self { return .seconds(25) }
        return .seconds(10)
    }
}
