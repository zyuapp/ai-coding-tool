import Foundation
import Network
import Observation
import UIKit

/// The one impure part: a socket, its timers, and what iOS does to an app it suspends. Every
/// decision comes from `MobileClient.reduce`; this only performs the effects and feeds back what it hears.
@MainActor
@Observable
final class PhoneConnection {
    private(set) var state: MobileClientState
    private(set) var origin: URL?

    static let connectTimeout: Duration = .seconds(10)
    /// The computer pings every 15 seconds, so silence past this means the line is gone.
    static let staleAfter: Duration = .seconds(20)
    static let probeTimeout: Duration = .seconds(5)
    static let queryTimeout: Duration = .seconds(10)
    static let offline = "Not connected to your computer."

    @ObservationIgnored private let storage: PhoneStorage
    @ObservationIgnored private let session = URLSession(configuration: .default)
    @ObservationIgnored private var socket: URLSessionWebSocketTask?
    @ObservationIgnored private var socketDelegate: SocketDelegate?
    @ObservationIgnored private var retry: Task<Void, Never>?
    @ObservationIgnored private var settle: Task<Void, Never>?
    @ObservationIgnored private var deadline: Task<Void, Never>?
    @ObservationIgnored private var reminder: Task<Void, Never>?
    @ObservationIgnored private var lastHeardAt = Date()
    @ObservationIgnored private var reads: [String: CheckedContinuation<JSONValue, Error>] = [:]
    @ObservationIgnored private var readTimers: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private var monitor: NWPathMonitor?
    @ObservationIgnored private var pathSatisfied = true
    @ObservationIgnored private var pathSignature: String?
    @ObservationIgnored private var foreground = true
    @ObservationIgnored private var storedVocabulary: MobileVocabulary?

    init(storage: PhoneStorage = PhoneStorage()) {
        self.storage = storage
        let computer = storage.readComputer()
        origin = computer?.origin ?? storage.origin
        storedVocabulary = storage.vocabulary
        state = MobileClientState(credential: computer?.credential, code: nil, deviceName: Self.deviceName, outbox: storage.readOutbox(), vocabulary: storedVocabulary)
        reminder = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(MobileClient.resendMs))
                self?.dispatch(.remind)
            }
        }
        watchNetwork()
        if state.credential != nil { open() }
    }

    /// Whole milliseconds since 1970, as the computer's clock fields are counted.
    static var now: Double { (Date.now.timeIntervalSince1970 * 1000).rounded() }

    static var deviceName: String {
        UIDevice.current.userInterfaceIdiom == .pad ? "iPad" : "iPhone"
    }

    /// Starts over with a link the computer's QR code carries.
    func pair(with link: PairingLink) {
        drop()
        retry?.cancel()
        settle?.cancel()
        // Another computer's build may name its engines differently, so only the same computer's vocabulary is kept.
        let keepVocabulary = link.origin == origin ? state.vocabulary : nil
        origin = link.origin
        storage.origin = link.origin
        state = MobileClientState(credential: nil, code: link.code, deviceName: Self.deviceName, vocabulary: keepVocabulary)
        storage.writeOutbox([])
        open()
    }

    func send(_ command: PhoneCommand) {
        dispatch(.dispatch(requestId: UUID().uuidString.lowercased(), command: command, at: Self.now))
    }

    func dismissNotice() {
        dispatch(.dismissNotice)
    }

    /// One read, answered by the computer or refused. A read is never held for a line that is down.
    func query(_ query: MobileQuery) async throws -> JSONValue {
        guard state.connection == .live, let socket else { throw QueryError(message: Self.offline) }
        let requestId = UUID().uuidString.lowercased()
        return try await withCheckedThrowingContinuation { continuation in
            reads[requestId] = continuation
            readTimers[requestId] = Task { [weak self] in
                try? await Task.sleep(for: Self.queryTimeout)
                guard !Task.isCancelled else { return }
                self?.finishRead(requestId, .failure(QueryError(message: "Your computer did not answer in time.")))
            }
            socket.send(.string(MobileClientMessage.query(requestId: requestId, query: query.json).text)) { _ in }
        }
    }

    struct QueryError: LocalizedError {
        var message: String
        var errorDescription: String? { message }
    }

    /// The app came back to the foreground. A line silent too long is redialled now; one that looks
    /// fine is asked whether it still carries anything, and cut if it does not answer soon.
    func becameActive() {
        foreground = true
        let stale = socket != nil && (socket?.state != .running || Date().timeIntervalSince(lastHeardAt) > Self.staleAfter.seconds)
        dispatch(.wake(stale: stale))
        probe()
    }

    func resignedActive() {
        foreground = false
    }

    private func dispatch(_ event: MobileClientEvent) {
        let (next, effects) = MobileClient.reduce(state, event)
        if next != state { state = next }
        for effect in effects { perform(effect) }
    }

    private func perform(_ effect: MobileClientEffect) {
        switch effect {
        case .send(let message):
            guard let socket, socket.state == .running else { return }
            socket.send(.string(message.text)) { _ in }
        case .store(let credential):
            if let credential, let origin {
                storage.writeComputer(PairedComputer(origin: origin, credential: credential))
            } else {
                storage.writeComputer(nil)
            }
        case .keep(let outbox):
            storage.writeOutbox(outbox)
        case .disconnect:
            drop()
        case .connect(let delayMs):
            retry?.cancel()
            retry = Task { [weak self] in
                try? await Task.sleep(for: .milliseconds(delayMs))
                guard !Task.isCancelled else { return }
                self?.open()
            }
        case .settle(let delayMs):
            settle?.cancel()
            settle = Task { [weak self] in
                try? await Task.sleep(for: .milliseconds(delayMs))
                guard !Task.isCancelled else { return }
                self?.dispatch(.settled)
            }
        }
        if case .send = effect {} else { rememberVocabulary() }
    }

    private func rememberVocabulary() {
        guard state.vocabulary != storedVocabulary else { return }
        storedVocabulary = state.vocabulary
        storage.vocabulary = state.vocabulary
    }

    private func disarm() {
        deadline?.cancel()
        deadline = nil
    }

    private func arm(_ delay: Duration) {
        disarm()
        deadline = Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled, let self else { return }
            let dead = self.socket
            self.drop()
            if dead != nil { self.dispatch(.closed) }
        }
    }

    private func watch() {
        lastHeardAt = Date()
        arm(Self.staleAfter)
    }

    /// Closes the line without asking for another: a deliberate hang-up is not a dropped call.
    private func drop() {
        disarm()
        refuseReads()
        let closing = socket
        socket = nil
        socketDelegate?.owner = nil
        socketDelegate = nil
        closing?.cancel(with: .normalClosure, reason: nil)
    }

    private func open() {
        guard socket == nil, let origin, let url = socketURL(origin: origin) else { return }
        let delegate = SocketDelegate(owner: self)
        let task = session.webSocketTask(with: url)
        task.delegate = delegate
        task.maximumMessageSize = 64 * 1024 * 1024
        socketDelegate = delegate
        socket = task
        arm(Self.connectTimeout)
        task.resume()
        receive(on: task)
    }

    fileprivate func socketOpened(_ task: URLSessionWebSocketTask) {
        guard task === socket else { return }
        watch()
        dispatch(.opened(at: Self.now))
        rememberVocabulary()
    }

    fileprivate func socketClosed(_ task: URLSessionWebSocketTask) {
        guard task === socket else { return }
        disarm()
        socket = nil
        socketDelegate = nil
        refuseReads()
        dispatch(.closed)
    }

    private func receive(on task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            Task { @MainActor [weak self] in
                guard let self, task === self.socket else { return }
                switch result {
                case .failure:
                    self.socketClosed(task)
                case .success(let message):
                    self.watch()
                    if case .string(let text) = message { self.heard(text) }
                    if task === self.socket { self.receive(on: task) }
                }
            }
        }
    }

    private func heard(_ text: String) {
        let (message, sequence) = parseServerFrame(text)
        guard let message else {
            if let sequence { dispatch(.skipped(sequence: sequence)) }
            return
        }
        if case .answer(_, let requestId, let result) = message {
            finishRead(requestId, result.mapError { QueryError(message: $0.message) as Error })
        }
        dispatch(.received(message))
    }

    private func finishRead(_ requestId: String, _ result: Result<JSONValue, Error>) {
        readTimers.removeValue(forKey: requestId)?.cancel()
        reads.removeValue(forKey: requestId)?.resume(with: result)
    }

    private func refuseReads() {
        for requestId in Array(reads.keys) { finishRead(requestId, .failure(QueryError(message: Self.offline))) }
    }

    private func probe() {
        guard let socket, socket.state == .running, state.connection == .live else { return }
        socket.send(.string(MobileClientMessage.ping(at: Self.now).text)) { _ in }
        arm(Self.probeTimeout)
    }

    /// The network moved under the app: a socket that rode the old one is redialled now, and one with
    /// no network at all is down whatever it has yet to notice.
    private func watchNetwork() {
        let monitor = NWPathMonitor()
        monitor.pathUpdateHandler = { [weak self] path in
            let satisfied = path.status == .satisfied
            let signature = path.availableInterfaces.map(\.name).joined(separator: ",")
            Task { @MainActor [weak self] in self?.networkChanged(satisfied: satisfied, signature: signature) }
        }
        monitor.start(queue: DispatchQueue(label: "com.zyuapp.aicodingtool.network"))
        self.monitor = monitor
    }

    private func networkChanged(satisfied: Bool, signature: String) {
        let first = pathSignature == nil
        let moved = !pathSatisfied || (pathSignature != nil && pathSignature != signature)
        pathSatisfied = satisfied
        pathSignature = signature
        if !satisfied {
            guard socket != nil else { return }
            drop()
            dispatch(.closed)
            return
        }
        guard foreground, !first, moved else { return }
        dispatch(.wake(stale: socket != nil))
    }
}

private final class SocketDelegate: NSObject, URLSessionWebSocketDelegate, @unchecked Sendable {
    weak var owner: PhoneConnection?

    init(owner: PhoneConnection) {
        self.owner = owner
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        Task { @MainActor [weak self] in self?.owner?.socketOpened(webSocketTask) }
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        Task { @MainActor [weak self] in self?.owner?.socketClosed(webSocketTask) }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let socket = task as? URLSessionWebSocketTask else { return }
        Task { @MainActor [weak self] in self?.owner?.socketClosed(socket) }
    }
}

private extension Duration {
    var seconds: Double {
        let (seconds, attoseconds) = components
        return Double(seconds) + Double(attoseconds) / 1e18
    }
}
