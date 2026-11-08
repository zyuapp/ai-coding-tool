import Foundation

// The phone's behaviour as one reducer: what the socket says, what the user does and what iOS does
// to a suspended app arrive as events, and every action the driver must take comes back as an
// effect. Nothing here opens a socket or reads the clock.

struct MobileCredential: Codable, Equatable, Sendable {
    var token: String
    var deviceId: String
    var deviceName: String
}

enum MobileEntry: String, Sendable {
    case pairing, ready, blocked
}

enum ConnectionState: String, Sendable {
    case offline, connecting, resuming, live

    var label: String {
        switch self {
        case .offline: "Offline"
        case .connecting: "Connecting"
        case .resuming: "Catching up"
        case .live: "Live"
        }
    }
}

/// A command the user has asked for, kept until the computer acknowledges it by id.
struct OutboxEntry: Codable, Equatable, Sendable {
    var requestId: String
    var command: PhoneCommand
    var sent: Bool
    var queuedAt: Double
    var writes: Int
    var instance: String?
}

/// A command the computer turned down, handed back so the screen that sent it can give the user their words back.
struct ReturnedCommand: Equatable, Sendable {
    var requestId: String
    var command: PhoneCommand
    var message: String
}

struct MobileClientState: Equatable, Sendable {
    var entry: MobileEntry
    var credential: MobileCredential?
    var code: String?
    var deviceName: String
    var connection: ConnectionState = .offline
    var sessionId: String?
    var lastSequence = 0
    /// Set by the first snapshot, after which the view, not the stored one, carries the theme.
    var synced = false
    var instance: String?
    var view = MobileView.empty
    var vocabulary: MobileVocabulary?
    var outbox: [OutboxEntry] = []
    var returned: ReturnedCommand?
    var openedAt: Double = 0
    var attempt = 0
    var notice: String?
    var dismissedError: String?

    init(credential: MobileCredential?, code: String?, deviceName: String, outbox: [OutboxEntry] = [], vocabulary: MobileVocabulary? = nil) {
        let entry: MobileEntry = credential != nil ? .ready : code != nil ? .pairing : .blocked
        self.entry = entry
        self.credential = credential
        self.code = code
        self.deviceName = deviceName
        self.outbox = credential != nil ? outbox : []
        self.vocabulary = vocabulary
        notice = entry == .blocked ? MobileClient.scanAgain : nil
    }
}

enum MobileClientEvent: Sendable {
    case opened(at: Double)
    case received(MobileServerMessage)
    case skipped(sequence: Int)
    case closed
    case dispatch(requestId: String, command: PhoneCommand, at: Double)
    case remind
    case settled
    case wake(stale: Bool)
    case dismissNotice
}

enum MobileClientEffect: Equatable, Sendable {
    case send(MobileClientMessage)
    case connect(delayMs: Int)
    case disconnect
    case settle(delayMs: Int)
    case store(MobileCredential?)
    case keep([OutboxEntry])
}

enum MobileClient {
    static let retryBaseMs = 500
    static let retryMaxMs = 15_000
    static let settleMs = 750
    static let outboxLimit = 50
    static let resendMs = 10_000
    static let resendLimit = 6
    static let staleCommandMs: Double = 30_000

    static let scanAgain = "Scan the QR code on your computer to connect this phone."
    static let restarted = "Your computer restarted. Check that your last taps went through."
    static let outOfDate = "This app is out of date for your computer. Update the app to carry on."

    /// Commands that only move what the phone is looking at: only the last one asked for is worth sending.
    static let viewCommands: Set<String> = ["task.select", "task.new"]
    /// Commands that act on a run as it stood when asked, dropped rather than carried out late.
    static let momentCommands: Set<String> = ["run.cancel", "run.decide"]

    static func backoffDelay(_ attempt: Int) -> Int {
        if attempt <= 1 { return retryBaseMs }
        let exponent = min(attempt - 1, 16)
        return min(retryMaxMs, retryBaseMs * (1 << exponent))
    }

    static func refusal(_ code: MobileErrorCode) -> String? {
        switch code {
        case .version: outOfDate
        case .unauthorized: "This phone is no longer paired. Scan a fresh QR code on your computer."
        case .expiredCode: "That pairing code has expired. Scan a fresh QR code on your computer."
        case .rateLimited: "The computer is turning connections away. Trying again shortly."
        case .unreadable, .internalError: nil
        }
    }

    static func shouldReconnect(_ state: MobileClientState) -> Bool {
        state.entry != .blocked
    }

    static func reduce(_ state: MobileClientState, _ event: MobileClientEvent) -> (MobileClientState, [MobileClientEffect]) {
        var (next, effects) = reduceEvent(state, event)
        if next.outbox != state.outbox { effects.append(.keep(next.outbox)) }
        return (next, effects)
    }

    private static func reduceEvent(_ state: MobileClientState, _ event: MobileClientEvent) -> (MobileClientState, [MobileClientEffect]) {
        switch event {
        case .opened(let at):
            var next = state
            next.openedAt = at
            return opened(next)
        case .received(let message):
            return received(state, message)
        case .skipped(let sequence):
            if sequence <= state.lastSequence { return (state, []) }
            if state.sessionId != nil, sequence > state.lastSequence + 1 { return resync(state) }
            var next = state
            next.lastSequence = sequence
            return (next, [])
        case .closed:
            return closed(state)
        case .dispatch(let requestId, let command, let at):
            return dispatch(state, requestId: requestId, command: command, at: at)
        case .remind:
            return state.connection == .live ? flush(state, owed: state.outbox.filter(\.sent)) : (state, [])
        case .settled:
            if state.connection == .live { return flush(state, owed: state.outbox) }
            if state.connection == .offline { return (state, []) }
            return (state, [.settle(delayMs: settleMs)])
        case .wake(let stale):
            guard shouldReconnect(state) else { return (state, []) }
            var next = state
            if state.connection == .offline {
                next.attempt = 0
                return (next, [.connect(delayMs: 0)])
            }
            guard stale else { return (state, []) }
            next.attempt = 0
            next.connection = state.lastSequence > 0 ? .resuming : .connecting
            return (next, [.disconnect, .connect(delayMs: 0)])
        case .dismissNotice:
            var next = state
            next.notice = nil
            next.dismissedError = state.view.error
            return (next, [])
        }
    }

    private static func opened(_ state: MobileClientState) -> (MobileClientState, [MobileClientEffect]) {
        var next = state
        if let credential = state.credential {
            next.connection = state.lastSequence > 0 ? .resuming : .connecting
            return (next, [.send(.resume(token: credential.token, sessionId: state.sessionId, lastSequence: state.lastSequence)), .settle(delayMs: settleMs)])
        }
        if let code = state.code {
            next.connection = .connecting
            return (next, [.send(.pair(code: code, deviceName: state.deviceName))])
        }
        next.connection = .offline
        next.entry = .blocked
        next.notice = state.notice ?? scanAgain
        return (next, [.disconnect])
    }

    private static func closed(_ state: MobileClientState) -> (MobileClientState, [MobileClientEffect]) {
        var next = state
        next.attempt = state.attempt + 1
        next.connection = .offline
        guard shouldReconnect(state) else { return (next, []) }
        return (next, [.connect(delayMs: backoffDelay(next.attempt))])
    }

    private static func dispatch(_ state: MobileClientState, requestId: String, command: PhoneCommand, at: Double) -> (MobileClientState, [MobileClientEffect]) {
        let live = state.connection == .live
        let kept = live || !viewCommands.contains(command.type) ? state.outbox : withoutTrailingMoves(state.outbox)
        var next = state
        if kept.count >= outboxLimit {
            next.notice = "Too much is already waiting for your computer. Wait for it to catch up."
            return (next, [])
        }
        let entry = OutboxEntry(requestId: requestId, command: command, sent: live, queuedAt: at, writes: live ? 1 : 0, instance: live ? state.instance : nil)
        next.outbox = kept + [entry]
        return (next, live ? [.send(.command(requestId: requestId, command: command))] : [])
    }

    private static func withoutTrailingMoves(_ outbox: [OutboxEntry]) -> [OutboxEntry] {
        var end = outbox.count
        while end > 0, !outbox[end - 1].sent, viewCommands.contains(outbox[end - 1].command.type) { end -= 1 }
        return Array(outbox[0..<end])
    }

    /// Writes every command owed a send, in the order it was asked. One written as often as the
    /// limit allows without an answer is given up on, and the user told.
    private static func flush(_ state: MobileClientState, owed: [OutboxEntry]) -> (MobileClientState, [MobileClientEffect]) {
        guard !owed.isEmpty else { return (state, []) }
        let owedIds = Set(owed.map(\.requestId))
        let spentIds = Set(owed.filter { $0.writes >= resendLimit }.map(\.requestId))
        let effects = owed.filter { !spentIds.contains($0.requestId) }.map { MobileClientEffect.send(.command(requestId: $0.requestId, command: $0.command)) }
        var next = state
        next.outbox = state.outbox.compactMap { item in
            if spentIds.contains(item.requestId) { return nil }
            guard owedIds.contains(item.requestId) else { return item }
            var written = item
            written.sent = true
            written.writes += 1
            written.instance = item.instance ?? state.instance
            return written
        }
        if !spentIds.isEmpty { next.notice = "Your computer did not answer. Try again." }
        return (next, effects)
    }

    /// The line is answering again: everything still owed is written in order, and a stop or a
    /// decision that waited too long is dropped.
    private static func live(_ state: MobileClientState) -> (MobileClientState, [MobileClientEffect]) {
        var next = state
        next.connection = .live
        next.attempt = 0
        if state.connection == .live { return flush(next, owed: next.outbox.filter { !$0.sent }) }
        let late = next.outbox.filter { momentCommands.contains($0.command.type) && next.openedAt - $0.queuedAt > staleCommandMs }
        if !late.isEmpty {
            let lateIds = Set(late.map(\.requestId))
            next.outbox.removeAll { lateIds.contains($0.requestId) }
            next.notice = "Some taps were not sent: the line was down too long."
        }
        return flush(next, owed: next.outbox)
    }

    private static func received(_ state: MobileClientState, _ message: MobileServerMessage) -> (MobileClientState, [MobileClientEffect]) {
        if case .error(_, let code, let text) = message { return refused(state, code: code, message: text) }
        switch message {
        case .snapshot, .paired: break
        default:
            if message.sequence <= state.lastSequence { return (state, []) }
            if state.sessionId != nil, message.sequence > state.lastSequence + 1 { return resync(state) }
        }
        var seen = state
        seen.lastSequence = message.sequence
        func settled(_ next: MobileClientState) -> (MobileClientState, [MobileClientEffect]) {
            state.sessionId == nil ? (next, []) : live(next)
        }
        switch message {
        case .paired(_, let deviceId, let deviceName, let token):
            let credential = MobileCredential(token: token, deviceId: deviceId, deviceName: deviceName)
            seen.credential = credential
            seen.code = nil
            seen.entry = .ready
            seen.notice = nil
            return (seen, [.store(credential)])
        case .snapshot(_, let sessionId, let view, let instance, let vocabulary):
            var kept = sessionId == seen.sessionId ? seen : restarted(seen, instance: instance)
            kept.notice = kept.outbox == seen.outbox ? nil : restarted
            kept.synced = true
            kept.instance = instance
            kept.sessionId = sessionId
            kept.vocabulary = vocabulary
            return live(shown(kept, view))
        case .patch(_, let patch):
            guard let view = seen.view.applying(patch) else { return resync(state) }
            return settled(shown(seen, view))
        case .ack(_, let requestId, let ok, let text):
            let asked = seen.outbox.first { $0.requestId == requestId }
            seen.outbox.removeAll { $0.requestId == requestId }
            if ok { return settled(seen) }
            if let asked { seen.returned = ReturnedCommand(requestId: asked.requestId, command: asked.command, message: text) }
            seen.notice = text
            return settled(seen)
        case .answer:
            return settled(seen)
        case .ping(_, let at):
            var (next, effects) = settled(seen)
            effects.append(.send(.pong(at: at)))
            return (next, effects)
        case .error:
            return (state, [])
        }
    }

    /// Only a command written to this very server is sent again after a restart; the rest are let
    /// go of, since a server that forgot them could run them twice.
    private static func restarted(_ state: MobileClientState, instance: String?) -> MobileClientState {
        var next = state
        next.outbox = state.outbox.filter { $0.writes == 0 || (instance != nil && $0.instance == instance) }
        return next
    }

    private static func shown(_ state: MobileClientState, _ view: MobileView) -> MobileClientState {
        var next = state
        if view.error != state.view.error { next.dismissedError = nil }
        next.view = view
        return next
    }

    /// A gap in the numbering means a frame was lost, so the phone starts over from a snapshot.
    private static func resync(_ state: MobileClientState) -> (MobileClientState, [MobileClientEffect]) {
        var next = state
        next.attempt = state.attempt + 1
        next.sessionId = nil
        next.lastSequence = 0
        next.connection = .connecting
        return (next, [.disconnect, .connect(delayMs: state.attempt > 0 ? backoffDelay(next.attempt) : 0)])
    }

    private static func refused(_ state: MobileClientState, code: MobileErrorCode, message: String) -> (MobileClientState, [MobileClientEffect]) {
        var next = state
        if code == .rateLimited, state.credential != nil {
            next.attempt = state.attempt + 1
            next.connection = .offline
            next.notice = refusal(.rateLimited)
            return (next, [.disconnect, .connect(delayMs: backoffDelay(next.attempt))])
        }
        if code == .unauthorized, state.code != nil {
            next.credential = nil
            next.entry = .pairing
            next.connection = .offline
            next.sessionId = nil
            next.lastSequence = 0
            next.notice = nil
            return (next, [.store(nil), .disconnect, .connect(delayMs: 0)])
        }
        if code == .version {
            // An app cannot reload itself into a newer build, so it waits on the backoff in case the computer is what changes.
            next.attempt = state.attempt + 1
            next.connection = .offline
            next.notice = outOfDate
            return (next, [.disconnect, .connect(delayMs: backoffDelay(next.attempt))])
        }
        let sentence = code == .rateLimited ? message : refusal(code)
        guard let sentence else {
            next.notice = message
            return (next, [])
        }
        next.entry = .blocked
        next.notice = sentence
        next.connection = .offline
        if code == .expiredCode { next.code = nil }
        if code == .unauthorized {
            next.credential = nil
            return (next, [.store(nil), .disconnect])
        }
        return (next, [.disconnect])
    }
}
