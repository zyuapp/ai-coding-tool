import Foundation
import Observation

/// Where the phone is past the thread list: the thread the computer has open, or that thread's changes.
enum Route: Hashable {
    case thread
    case changes
    case archived
}

/// A thread the phone has asked the computer to open: what to show meanwhile, what it waits for, and the commands that asked.
struct Opening: Equatable {
    var title: String
    var project: String?
    /// The thread id asked for, or "draft" for a new thread.
    var want: String
    /// What the computer had open when it was asked.
    var was: String
    var commands: [PhoneCommand]
}

/// The phone's screens and what they ask of the computer. The conversation is the one the computer
/// has open, so the phone asks for a thread and then shows whichever one arrives.
@MainActor
@Observable
final class PhoneModel {
    let connection: PhoneConnection
    @ObservationIgnored let pictures = PictureStore()
    var path: [Route] = []
    private(set) var opening: Opening?
    private(set) var missed: Opening?
    var activityProject: String? {
        didSet { storage.activityProject = activityProject }
    }
    var folded: Set<String> {
        didSet { storage.folded = folded }
    }
    /// Unsent words by thread, kept for as long as the app runs.
    @ObservationIgnored private var drafts: [String: String] = [:]
    @ObservationIgnored private var refilledFrom: String?
    /// The draft last filled from outside its composer, so a composer showing it reads it again, and
    /// takes the keyboard when the words are ones to rewrite.
    private(set) var refilled: (id: UUID, key: String, focus: Bool)?

    @ObservationIgnored private let storage: PhoneStorage
    /// The thread whose changes the changes screen shows.
    @ObservationIgnored private var changesOf: String?
    @ObservationIgnored private var openingTimer: Task<Void, Never>?
    @ObservationIgnored private var updatesChecked: (origin: URL?, at: Date)?
    @ObservationIgnored private var usageRead: (origin: URL?, at: Date)?
    /// Each "/" menu read, by computer, checkout and engine: empty when the computer had none to give.
    private(set) var commandLists: [String: [SlashCommand]] = [:]
    @ObservationIgnored private var commandsRead: [String: Date] = [:]

    init(connection: PhoneConnection, storage: PhoneStorage = PhoneStorage()) {
        self.connection = connection
        self.storage = storage
        activityProject = storage.activityProject
        folded = storage.folded
    }

    var state: MobileClientState { connection.state }
    var view: MobileView { connection.state.view }
    var live: Bool { state.connection == .live }
    /// Commands only wait on the line while it is down; on a live one they are simply on their way.
    var waiting: Int { live ? 0 : state.outbox.count }
    var catalog: EngineCatalog { EngineCatalog(vocabulary: state.vocabulary, engines: view.engines) }
    var notice: String? { state.notice ?? (view.error != state.dismissedError ? view.error : nil) }
    /// Whether holding Send can listen: the computer has its speech model and the line is up.
    var canDictate: Bool { live && view.dictation == true }

    /// What the computer has open: a thread's id, "draft", or "none".
    var current: String {
        if let thread = view.thread { return thread.id }
        return view.draft != nil ? "draft" : "none"
    }

    /// Whether the phone is still waiting for the thread it asked for.
    var pending: Bool {
        guard let opening else { return false }
        return current == opening.was && current != opening.want
    }

    @discardableResult
    func send(_ command: PhoneCommand) -> String {
        connection.send(command)
    }

    /// The computer's words for a held recording.
    func transcribe(_ wav: Data) async throws -> String {
        struct Heard: Decodable { var text: String }
        return try await connection.query(.transcribe(audio: wav.base64EncodedString())).decode(Heard.self).text
    }

    // MARK: Opening threads

    func openThread(_ taskId: String, title: String, project: String?) {
        request(Opening(title: title, project: project, want: taskId, was: current, commands: [.select(taskId)]))
    }

    func newThread(projectId: String?, project: String?, worktreeId: String? = nil, then extra: [PhoneCommand] = []) {
        request(Opening(title: "New thread", project: project, want: "draft", was: current, commands: [.newThread(projectId: projectId, worktreeId: worktreeId)] + extra))
    }

    func retryMissed() {
        guard let missed else { return }
        request(Opening(title: missed.title, project: missed.project, want: missed.want, was: current, commands: missed.commands))
    }

    private func request(_ ask: Opening) {
        missed = nil
        opening = ask
        if path != [.thread] { path = [.thread] }
        for command in ask.commands { send(command) }
        reconsiderOpening()
    }

    /// Lets go of an opening once the computer has moved, and gives up three seconds after the line is up.
    func reconsiderOpening() {
        if let missed, current == missed.want { self.missed = nil }
        guard let opening else {
            openingTimer?.cancel()
            return
        }
        if current != opening.was || current == opening.want {
            self.opening = nil
            openingTimer?.cancel()
            return
        }
        openingTimer?.cancel()
        guard live else { return }
        openingTimer = Task { [weak self] in
            try? await Task.sleep(for: .seconds(3))
            guard !Task.isCancelled, let self, self.opening == opening else { return }
            self.opening = nil
            self.missed = opening
        }
    }

    func back() {
        opening = nil
        missed = nil
        if !path.isEmpty { path.removeLast() }
    }

    /// Called when the navigation stack pops on its own, such as by the edge swipe.
    func pathChanged() {
        if path.isEmpty {
            opening = nil
            missed = nil
        }
    }

    func enterChanges() {
        changesOf = view.thread?.id
        if path.last != .changes { path.append(.changes) }
    }

    /// The changes screen belongs to one thread; when the computer moves on, so does the phone.
    func threadMoved() {
        if path.last == .changes, view.thread?.id != changesOf { path.removeLast() }
    }

    // MARK: Updates

    /// Whether the line dropped because the computer is restarting into the update it was installing.
    var restarting: Bool { !live && view.installingUpdate }

    /// Has the computer look for a newer app and engines now, at most once a minute per computer.
    func checkForUpdates() {
        guard live, view.upkeep != nil else { return }
        let origin = connection.origin
        if let checked = updatesChecked, checked.origin == origin, Date().timeIntervalSince(checked.at) < 60 { return }
        updatesChecked = (origin, Date())
        send(.checkForUpdates)
        send(.rereadEngines)
    }

    /// Has the computer read its plan limits again, unless this phone asked it within `gap` seconds.
    /// Each read starts a session with every provider, so only a pull asks with no gap.
    func readUsage(within gap: TimeInterval) {
        guard live, view.usage != nil else { return }
        let origin = connection.origin
        if let read = usageRead, read.origin == origin, Date().timeIntervalSince(read.at) < gap { return }
        usageRead = (origin, Date())
        send(.readUsage)
    }

    // MARK: Actions

    func archive(_ taskId: String, leaving: Bool) {
        if leaving { back() }
        send(.archive(taskId))
    }

    func dismiss(_ taskId: String) {
        send(.dismiss(taskId))
    }

    func dismissAll(projectId: String?) {
        send(.dismissAll(projectId: projectId))
    }

    func toggleFolded(_ key: String) {
        if folded.contains(key) { folded.remove(key) } else { folded.insert(key) }
    }

    /// The project a new thread from the list starts in: the one the list is narrowed to, else the most recently active.
    var startingProject: MobileProjectGroup? {
        if let activityProject, let group = view.groups.first(where: { $0.projectId == activityProject }) { return group }
        var latest: (MobileProjectGroup, Double)?
        for group in view.groups {
            for entry in group.threads where latest == nil || entry.lastActivityAt > latest!.1 { latest = (group, entry.lastActivityAt) }
        }
        return latest?.0.projectId != nil ? latest?.0 : nil
    }

    // MARK: Composer

    func draft(for key: String) -> String { drafts[key] ?? "" }

    func keepDraft(_ text: String, for key: String) {
        drafts[key] = text.isEmpty ? nil : text
    }

    /// Where a "/" menu is read from: the thread, or the draft when `taskId` is nil, and the checkout and
    /// engine it runs in, which is what the list is kept by.
    struct CommandScope: Equatable {
        var taskId: String?
        var checkout: String
        var engine: String
    }

    private func commandsKey(_ scope: CommandScope) -> String {
        "\(connection.origin?.absoluteString ?? "")|\(scope.checkout)|\(scope.engine)"
    }

    /// The list last read for the scope, or nil before its first read has answered.
    func commands(for scope: CommandScope) -> [SlashCommand]? { commandLists[commandsKey(scope)] }

    /// Reads the scope's list again at most once a minute, keeping the last one meanwhile, so skills
    /// installed since show up without typing waiting on the computer. A read nobody answered, such as
    /// one cut off by the line dropping, is tried again the next time the menu opens or the line returns.
    func readCommands(for scope: CommandScope) {
        guard live else { return }
        let key = commandsKey(scope)
        if let read = commandsRead[key], Date().timeIntervalSince(read) < 60 { return }
        let started = Date()
        commandsRead[key] = started
        Task {
            do {
                let answer = try await connection.query(.commands(taskId: scope.taskId)).decode(CommandDiscovery.self)
                commandLists[key] = answer.commands ?? commandLists[key] ?? []
            } catch {
                if commandsRead[key] == started { commandsRead[key] = nil }
                commandLists[key] = commandLists[key] ?? []
            }
        }
    }

    /// The thread whose older messages are being read, so a second tap waits for the first.
    private(set) var readingEarlier: String?
    /// Why the last read of a thread's older messages failed, shown until the next try.
    private(set) var earlierFailed: (taskId: String, message: String)?

    /// The open thread's messages with any older ones read above them, and how many are still on the computer.
    func transcript(_ thread: MobileThreadView) -> (messages: [MobileMessage], omitted: Int) {
        guard let earlier = state.earlier, earlier.taskId == thread.id, earlier.end == thread.omitted else { return (thread.messages, thread.omitted) }
        return (earlier.messages + thread.messages, earlier.start)
    }

    /// Reads the page of messages just above what the thread shows. A page the live window slid past
    /// while it was read no longer meets it, and is asked for again from where the window now starts.
    func readEarlier(_ taskId: String) {
        guard readingEarlier == nil else { return }
        readingEarlier = taskId
        earlierFailed = nil
        Task {
            defer { readingEarlier = nil }
            do {
                for _ in 0..<3 {
                    guard let thread = view.thread, thread.id == taskId, transcript(thread).omitted > 0 else { return }
                    let page = try await connection.query(.history(taskId: taskId, before: transcript(thread).omitted)).decode(MobileThreadHistory.self)
                    guard let now = view.thread, now.id == taskId else { return }
                    if page.end == transcript(now).omitted { return connection.keepEarlier(taskId, page) }
                }
                earlierFailed = (taskId, "The thread moved while reading. Try again.")
            } catch {
                earlierFailed = (taskId, error.localizedDescription)
            }
        }
    }

    /// Spoken words follow whatever that draft holds, whether or not its thread is still on screen.
    func addSpokenWords(_ words: String, to key: String) {
        let typed = draft(for: key).trimmingCharacters(in: .whitespacesAndNewlines)
        keepDraft(typed.isEmpty ? words : "\(typed) \(words)", for: key)
        refilled = (UUID(), key, false)
    }

    /// A queued message on its way out of the queue. The edit is kept with the outbox, so it outlives
    /// the app being closed and the phone talking to another computer meanwhile.
    var editing: (taskId: String, messageId: String)? {
        guard let entry = state.outbox.first(where: { $0.words != nil }), let taskId = entry.command.taskId, let messageId = entry.command.json["messageId"]?.stringValue else { return nil }
        return (taskId, messageId)
    }

    /// Asks for a queued message back; its words reach the composer only once it has left the queue.
    func editQueued(_ taskId: String, _ message: MobileQueuedMessage) {
        guard editing == nil else { return }
        connection.send(.editQueued(taskId, messageId: message.id), words: message.text)
    }

    /// Words of an edit the computer took join its thread's draft, whichever screen is showing.
    func takeRefill() {
        guard let refill = state.refill, refill.requestId != refilledFrom else { return }
        refilledFrom = refill.requestId
        let typed = draft(for: refill.taskId).trimmingCharacters(in: .whitespacesAndNewlines)
        keepDraft(typed.isEmpty ? refill.words : "\(typed)\n\n\(refill.words)", for: refill.taskId)
        refilled = (UUID(), refill.taskId, true)
    }
}
