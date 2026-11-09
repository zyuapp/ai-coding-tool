@testable import AICodingTool
import XCTest

final class ClientReducerTests: XCTestCase {
    private let code = "K7M2P9QX"
    private let token = String(repeating: "a", count: 64)

    private func thread(_ title: String, tail: String? = nil, messages: [MobileMessage] = []) -> MobileThreadView {
        MobileThreadView(loading: nil, id: "t1", title: title, projectId: "p", projectName: "App", worktreeId: nil, messages: messages, omitted: 0, streamingTail: tail, status: "idle", approval: nil, question: nil, queued: [], settings: MobileThreadSettings(engine: "claude", model: "opus", effort: "high", fastMode: nil, policy: "confirm", coordinating: nil), location: .local, worktrees: [], canMove: true, changes: nil, reviewable: true, branchRange: .branches(base: "HEAD", compare: nil))
    }

    private func view(_ title: String) -> MobileView {
        var view = MobileView.empty
        view.thread = thread(title)
        return view
    }

    private func snapshot(_ sequence: Int, session: String = "s1", title: String = "Thread", instance: String? = "one") -> MobileServerMessage {
        .snapshot(sequence: sequence, sessionId: session, view: view(title), instance: instance, vocabulary: nil, computer: nil)
    }

    private func run(_ state: MobileClientState, _ events: [MobileClientEvent]) -> (MobileClientState, [MobileClientEffect]) {
        events.reduce((state, [MobileClientEffect]())) { carried, event in
            let (next, effects) = MobileClient.reduce(carried.0, event)
            return (next, carried.1 + effects)
        }
    }

    private func sent(_ effects: [MobileClientEffect]) -> [MobileClientMessage] {
        effects.compactMap { if case .send(let message) = $0 { return message } else { return nil } }
    }

    private func paired() -> MobileClientState {
        let start = MobileClientState(credential: MobileCredential(token: token, deviceId: "d1", deviceName: "iPhone"), code: nil, deviceName: "iPhone")
        return run(start, [.opened(at: 0), .received(snapshot(1))]).0
    }

    func testCodeIsTradedForAToken() {
        let start = MobileClientState(credential: nil, code: code, deviceName: "iPhone")
        XCTAssertEqual(start.entry, .pairing)
        let (opened, effects) = run(start, [.opened(at: 0)])
        XCTAssertEqual(sent(effects), [.pair(code: code, deviceName: "iPhone")])
        let (done, stored) = run(opened, [.received(.paired(sequence: 1, deviceId: "d1", deviceName: "iPhone", token: token))])
        XCTAssertEqual(done.entry, .ready)
        XCTAssertNil(done.code)
        XCTAssertEqual(stored.last, .store(MobileCredential(token: token, deviceId: "d1", deviceName: "iPhone")))
    }

    func testExpiredCodeStopsTrying() {
        let start = MobileClientState(credential: nil, code: code, deviceName: "iPhone")
        let (refused, _) = run(start, [.opened(at: 0), .received(.error(sequence: 1, code: .expiredCode, message: "gone"))])
        XCTAssertEqual(refused.entry, .blocked)
        XCTAssertNil(refused.code)
        XCTAssertTrue(refused.notice?.contains("fresh QR code") == true)
        XCTAssertEqual(run(refused, [.closed]).1, [])
    }

    func testResumeNamesSessionAndLastSequence() {
        var state = paired()
        state = run(state, [.received(.ping(sequence: 2, at: 5)), .closed]).0
        let (_, effects) = run(state, [.opened(at: 10)])
        XCTAssertEqual(sent(effects), [.resume(token: token, sessionId: "s1", lastSequence: 2)])
    }

    func testCommandsWaitForTheLineAndGoInOrder() {
        var state = run(paired(), [.closed]).0
        XCTAssertEqual(state.connection, .offline)
        state = run(state, [.dispatch(requestId: "r1", command: .send("t1", text: "one"), at: 1), .dispatch(requestId: "r2", command: .send("t1", text: "two"), at: 2)]).0
        XCTAssertEqual(state.outbox.map(\.requestId), ["r1", "r2"])
        XCTAssertFalse(state.outbox.contains(where: \.sent))
        let (live, effects) = run(state, [.opened(at: 3), .received(snapshot(1))])
        XCTAssertEqual(live.connection, .live)
        XCTAssertEqual(sent(effects).compactMap { if case .command(let id, _) = $0 { return id } else { return nil } }, ["r1", "r2"])
        let (acked, _) = run(live, [.received(.ack(sequence: 2, requestId: "r1", ok: true, message: "")), .received(.ack(sequence: 3, requestId: "r2", ok: true, message: ""))])
        XCTAssertTrue(acked.outbox.isEmpty)
    }

    func testOnlyTheLastScreenMoveWaits() {
        var state = run(paired(), [.closed]).0
        state = run(state, [.dispatch(requestId: "a", command: .select("t1"), at: 1), .dispatch(requestId: "b", command: .select("t2"), at: 2)]).0
        XCTAssertEqual(state.outbox.map(\.requestId), ["b"])
    }

    func testStaleStopIsDropped() {
        var state = run(paired(), [.closed]).0
        state = run(state, [.dispatch(requestId: "stop", command: .cancel("t1"), at: 0)]).0
        let (live, _) = run(state, [.opened(at: 31_000), .received(snapshot(1))])
        XCTAssertTrue(live.outbox.isEmpty)
        XCTAssertEqual(live.notice, "Some taps were not sent: the line was down too long.")
    }

    func testRefusedCommandIsHandedBack() {
        let state = run(paired(), [.dispatch(requestId: "r1", command: .send("t1", text: "hello"), at: 1)]).0
        let (refused, _) = run(state, [.received(.ack(sequence: 2, requestId: "r1", ok: false, message: "No."))])
        XCTAssertEqual(refused.returned?.command.text, "hello")
        XCTAssertEqual(refused.notice, "No.")
    }

    func testOnlyAnEditTheComputerTookIsAccepted() {
        var state = run(paired(), [.dispatch(requestId: "edit", command: .editQueued("t1", messageId: "q1"), at: 1), .dispatch(requestId: "send", command: .send("t1", text: "hi"), at: 1)]).0
        state = run(state, [.received(.ack(sequence: 2, requestId: "send", ok: true, message: ""))]).0
        XCTAssertNil(state.accepted)
        state = run(state, [.received(.ack(sequence: 3, requestId: "edit", ok: true, message: ""))]).0
        XCTAssertEqual(state.accepted, "edit")
        state = run(state, [.dispatch(requestId: "late", command: .editQueued("t1", messageId: "q2"), at: 2), .received(.ack(sequence: 4, requestId: "late", ok: false, message: "That message has already been sent."))]).0
        XCTAssertEqual(state.accepted, "edit")
        XCTAssertEqual(state.returned?.requestId, "late")
        XCTAssertEqual(state.notice, "That message has already been sent.")
    }

    func testStaleDecisionReleasesItsCard() {
        var state = run(paired(), [.closed]).0
        let approval = MobileApproval(taskId: "t1", from: nil, approvalId: "a1", runId: "run", title: "", description: "", toolName: "Bash", detail: "")
        state = run(state, [.dispatch(requestId: "allow", command: .decide(approval, allow: true), at: 0)]).0
        let (live, _) = run(state, [.opened(at: 31_000), .received(snapshot(1))])
        XCTAssertEqual(live.returned?.requestId, "allow")
    }

    func testDraftSendRefusalKeepsTheWordsBeforeIt() {
        var state = run(paired(), [.dispatch(requestId: "words", command: .setPrompt("hello"), at: 1), .dispatch(requestId: "go", command: .send(nil, text: nil), at: 1)]).0
        state = run(state, [.received(.ack(sequence: 2, requestId: "words", ok: false, message: "Busy.")), .received(.ack(sequence: 3, requestId: "go", ok: false, message: "Busy."))]).0
        XCTAssertEqual(state.returned?.requestId, "words")
        XCTAssertEqual(state.notice, "Busy.")
    }

    func testRestartHandsBackWhatItDropped() {
        let state = run(paired(), [.dispatch(requestId: "r1", command: .send("t1", text: "one"), at: 1)]).0
        let (restarted, _) = run(state, [.closed, .opened(at: 2), .received(snapshot(1, session: "s2", instance: "two"))])
        XCTAssertEqual(restarted.returned?.command.text, "one")
    }

    func testGapInNumberingStartsOver() {
        let (state, effects) = run(paired(), [.received(.ping(sequence: 3, at: 0))])
        XCTAssertNil(state.sessionId)
        XCTAssertEqual(state.lastSequence, 0)
        XCTAssertEqual(effects, [.disconnect, .connect(delayMs: 0)])
    }

    func testPingIsAnswered() {
        let (_, effects) = run(paired(), [.received(.ping(sequence: 2, at: 42))])
        XCTAssertEqual(sent(effects), [.pong(at: 42)])
    }

    func testRestartDropsWhatTheNewServerNeverSaw() {
        let state = run(paired(), [.dispatch(requestId: "r1", command: .send("t1", text: "one"), at: 1)]).0
        XCTAssertEqual(state.outbox.first?.instance, "one")
        let (restarted, _) = run(state, [.closed, .opened(at: 2), .received(snapshot(1, session: "s2", instance: "two"))])
        XCTAssertTrue(restarted.outbox.isEmpty)
        XCTAssertEqual(restarted.notice, MobileClient.restarted)
    }

    func testRevokedPhoneForgetsItsToken() {
        let (state, effects) = run(paired(), [.received(.error(sequence: 2, code: .unauthorized, message: ""))])
        XCTAssertEqual(state.entry, .blocked)
        XCTAssertNil(state.credential)
        XCTAssertTrue(effects.contains(.store(nil)))
    }

    func testOutOfDateAppWaitsOnTheBackoff() {
        let (state, effects) = run(paired(), [.received(.error(sequence: 2, code: .version, message: ""))])
        XCTAssertEqual(state.notice, MobileClient.outOfDate)
        XCTAssertEqual(state.entry, .ready)
        XCTAssertTrue(effects.contains(.connect(delayMs: 500)))
    }

    func testOutOfDateComputerSaysWhichSideToUpdate() {
        let message = "AI Coding Tool on your computer is out of date for this app. Update it on your computer to carry on."
        let (state, _) = run(paired(), [.received(.error(sequence: 2, code: .version, message: message))])
        XCTAssertEqual(state.notice, message)
    }

    func testFullOutboxRefuses() {
        var state = run(paired(), [.closed]).0
        for index in 0..<MobileClient.outboxLimit {
            state = run(state, [.dispatch(requestId: "r\(index)", command: .send("t1", text: "\(index)"), at: 0)]).0
        }
        let (refused, _) = run(state, [.dispatch(requestId: "over", command: .send("t1", text: "x"), at: 0)])
        XCTAssertEqual(refused.outbox.count, MobileClient.outboxLimit)
        XCTAssertNotNil(refused.notice)
    }

    func testBackoffDoublesToItsCeiling() {
        XCTAssertEqual(MobileClient.backoffDelay(1), 500)
        XCTAssertEqual(MobileClient.backoffDelay(2), 1_000)
        XCTAssertEqual(MobileClient.backoffDelay(10), 15_000)
        XCTAssertEqual(MobileClient.backoffDelay(100), 15_000)
    }

    func testSnapshotNamesTheVocabulary() {
        let vocabulary = MobileVocabulary(engines: [], efforts: [MobileEffortTerm(id: "high", label: "High")])
        let start = MobileClientState(credential: MobileCredential(token: token, deviceId: "d1", deviceName: "iPhone"), code: nil, deviceName: "iPhone")
        let (state, _) = run(start, [.opened(at: 0), .received(.snapshot(sequence: 1, sessionId: "s1", view: .empty, instance: nil, vocabulary: vocabulary, computer: "Studio"))])
        XCTAssertEqual(state.vocabulary, vocabulary)
        let (older, _) = run(state, [.closed, .opened(at: 1), .received(snapshot(1, session: "s2"))])
        XCTAssertNil(older.vocabulary, "a computer that names none is not read with another build's names")
    }

    func testPushTokenGoesOnlyToAComputerThatTakesIt() {
        let push = PhonePush(token: String(repeating: "b", count: 64), environment: .production)
        let older = paired()
        XCTAssertEqual(sent(run(older, [.pushChanged(push)]).1), [], "a computer that never said it takes one is not sent one")

        let start = MobileClientState(credential: MobileCredential(token: token, deviceId: "d1", deviceName: "iPhone"), code: nil, deviceName: "iPhone")
        let newer = MobileServerMessage.snapshot(sequence: 1, sessionId: "s1", view: view("Thread"), instance: "one", vocabulary: nil, computer: nil, push: true)
        let (live, opening) = run(start, [.opened(at: 0), .received(newer)])
        XCTAssertTrue(sent(opening).contains(.pushToken(nil)), "a phone that may not show notices says so")

        let (allowed, effects) = run(live, [.pushChanged(push)])
        XCTAssertEqual(sent(effects), [.pushToken(push)])
        XCTAssertEqual(sent(run(allowed, [.pushChanged(push)]).1), [], "the same token is not sent twice")

        let (_, resumed) = run(allowed, [.closed, .opened(at: 1), .received(newer)])
        XCTAssertTrue(sent(resumed).contains(.pushToken(push)), "a computer is told again on every snapshot")
    }
}
