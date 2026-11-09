@testable import AICodingTool
import XCTest

final class ProtocolTests: XCTestCase {
    private func frame(_ json: String) -> MobileServerMessage? {
        parseServerFrame(json).message
    }

    private let threadJSON = """
    {"id":"t1","title":"Fix tests","projectId":"p","projectName":"App","worktreeId":null,"messages":[{"kind":"user","text":"hi","at":1},{"kind":"assistant","text":"hello","at":2}],"omitted":0,"streamingTail":"ab","status":"running","approval":null,"queued":[],"settings":{"engine":"claude","model":"opus","effort":"high","policy":"confirm"},"location":{"kind":"worktree","name":"wt","threads":2},"worktrees":[],"canMove":false,"changes":{"branch":"main","files":2,"additions":3,"deletions":1},"reviewable":true,"branchRange":{"kind":"branches","base":"main","compare":null}}
    """

    private func snapshotFrame() -> String {
        """
        {"kind":"snapshot","sequence":1,"sessionId":"s1","instance":"one","view":{"groups":[],"activity":{"priority":[],"running":[],"threads":[],"snoozed":[]},"theme":{"dark":"nord","light":"nord-snow","mode":"auto"},"engines":{"claude":{"access":"ready"}},"thread":\(threadJSON),"draft":null,"error":null},"vocabulary":{"engines":[{"id":"claude","label":"Claude","fastMode":false,"policies":[{"id":"confirm","label":"Confirm","description":"Ask"}],"models":[{"id":"opus","label":"Opus","description":"Best","efforts":["max","high"]}]}],"efforts":[{"id":"max","label":"Max"},{"id":"high","label":"High"}]}}
        """
    }

    private func snapshotView() throws -> MobileView {
        guard case .snapshot(_, _, let view, _, _, _, _)? = frame(snapshotFrame()) else { throw XCTSkip("snapshot did not parse") }
        return view
    }

    func testSnapshotDecodes() throws {
        guard case .snapshot(let sequence, let session, let view, let instance, let vocabulary, let computer, _)? = frame(snapshotFrame()) else { return XCTFail("snapshot did not parse") }
        XCTAssertEqual(sequence, 1)
        XCTAssertEqual(session, "s1")
        XCTAssertEqual(instance, "one")
        XCTAssertEqual(view.thread?.location, .worktree(name: "wt", threads: 2))
        XCTAssertEqual(view.thread?.branchRange, .branches(base: "main", compare: nil))
        XCTAssertEqual(vocabulary?.engines.first?.models.first?.efforts, ["max", "high"])
    }

    func testUpkeepTravelsWithTheCommandItSendsBack() throws {
        let view = try snapshotView()
        XCTAssertNil(view.upkeep, "a computer too old to be updated from the phone sends none")
        let patch = try JSONDecoder().decode(MobilePatch.self, from: Data(#"{"upkeep":[{"key":"app","label":"AI Coding Tool","version":"0.7.10","state":{"text":"0.7.11 available","tone":"offer"},"action":{"label":"Update","command":{"type":"app.update"}}},{"key":"codex","label":"Codex","version":null,"state":{"text":"Not installed","tone":"quiet"},"action":null}]}"#.utf8))
        let next = try XCTUnwrap(view.applying(patch))
        XCTAssertEqual(next.upkeep?.map(\.key), ["app", "codex"])
        XCTAssertEqual(next.upkeep?.first?.action?.command.json, .object(["type": .string("app.update")]))
        XCTAssertNil(next.upkeep?.last?.version)
        let untouched = try JSONDecoder().decode(MobilePatch.self, from: Data(#"{"groups":[]}"#.utf8))
        XCTAssertEqual(next.applying(untouched)?.upkeep, next.upkeep)
        XCTAssertEqual(PhoneCommand.checkForUpdates.json, .object(["type": .string("app.check-for-updates"), "quiet": .bool(true)]))
    }

    func testDictationTurnsOnAndOffWithThePatch() throws {
        let view = try snapshotView()
        XCTAssertNil(view.dictation, "a computer without dictation never says so")
        let on = try XCTUnwrap(view.applying(JSONDecoder().decode(MobilePatch.self, from: Data(#"{"dictation":true}"#.utf8))))
        XCTAssertEqual(on.dictation, true)
        let untouched = try JSONDecoder().decode(MobilePatch.self, from: Data(#"{"groups":[]}"#.utf8))
        XCTAssertEqual(on.applying(untouched)?.dictation, true)
        let off = try JSONDecoder().decode(MobilePatch.self, from: Data(#"{"dictation":false}"#.utf8))
        XCTAssertEqual(on.applying(off)?.dictation, false)
    }

    func testUsageArrivesWithThePatchAndStaysUntilItMoves() throws {
        let view = try snapshotView()
        XCTAssertNil(view.usage, "a computer too old to send limits never says so")
        let json = #"{"usage":{"engines":[{"engine":"claude","label":"Claude","plan":"Max plan","windows":[{"id":"five_hour","label":"Current session","share":42,"resetsAt":"2027-01-15T16:10:00Z"}]}],"composer":{"share":42,"meter":[{"span":"5h","share":42}],"spends":["five_hour"],"warning":null}}}"#
        let next = try XCTUnwrap(view.applying(JSONDecoder().decode(MobilePatch.self, from: Data(json.utf8))))
        XCTAssertEqual(next.usage?.engines.first?.windows.first?.share, 42)
        XCTAssertEqual(next.usage?.composer?.spends, ["five_hour"])
        let untouched = try JSONDecoder().decode(MobilePatch.self, from: Data(#"{"groups":[]}"#.utf8))
        XCTAssertEqual(next.applying(untouched)?.usage, next.usage)
        XCTAssertEqual(PhoneCommand.readUsage.json, .object(["type": .string("usage.read")]))
        XCTAssertEqual(PhoneCommand.dismissUsageWarning("claude:five_hour::near").json, .object(["type": .string("usage.dismiss-warning"), "warning": .string("claude:five_hour::near")]))
    }

    func testTranscribeQueryCarriesTheRecording() {
        XCTAssertEqual(MobileQuery.transcribe(audio: "UklGRg==").json, .object(["kind": .string("transcribe"), "audio": .string("UklGRg==")]))
        XCTAssertGreaterThan(MobileQuery.transcribe(audio: "").timeout, .seconds(120), "the computer may take its whole two minutes")
        XCTAssertEqual(MobileQuery.directories(prefix: "/").timeout, .seconds(10))
    }

    func testUpkeepMarksWhatWantsTheUser() throws {
        func item(_ key: String, tone: String?, command: PhoneCommand? = nil, installing: Bool? = nil) -> MobileUpkeepItem {
            MobileUpkeepItem(key: key, label: key, version: nil, state: .init(text: key, tone: tone), action: command.map { .init(label: "Go", command: $0) }, installing: installing)
        }
        var view = MobileView.empty
        view.upkeep = [item("app", tone: "quiet"), item("claude", tone: "offer"), item("codex", tone: "quiet")]
        XCTAssertEqual(view.pendingUpkeep.map(\.key), ["claude"], "a newer engine only the computer can install is still listed")
        XCTAssertFalse(view.updateOffered, "nothing the phone can start")

        view.upkeep = [item("codex", tone: "error", command: PhoneCommand("engine.update", ["engine": .string("codex")]))]
        XCTAssertTrue(view.updateOffered, "an engine too old to run marks the chip")
        view.upkeep = [item("app", tone: "progress", command: PhoneCommand("app.cancel-update"))]
        XCTAssertFalse(view.updateOffered, "an update already waiting needs nothing")
        XCTAssertFalse(view.installingUpdate)

        view.upkeep = [item("app", tone: "progress", installing: true)]
        XCTAssertTrue(view.installingUpdate)
        XCTAssertFalse(MobileView.empty.installingUpdate)
    }

    func testTailGrowsByUTF16Count() throws {
        let view = try snapshotView()
        let patch = try JSONDecoder().decode(MobilePatch.self, from: Data(#"{"thread":{"kind":"changed","id":"t1","delta":{"tail":{"from":2,"text":"c😀"}}}}"#.utf8))
        let grown = try XCTUnwrap(view.applying(patch))
        XCTAssertEqual(grown.thread?.streamingTail, "abc😀")
        let next = try JSONDecoder().decode(MobilePatch.self, from: Data(#"{"thread":{"kind":"changed","id":"t1","delta":{"tail":{"from":5,"text":"!"}}}}"#.utf8))
        XCTAssertEqual(grown.applying(next)?.thread?.streamingTail, "abc😀!")
        let wrong = try JSONDecoder().decode(MobilePatch.self, from: Data(#"{"thread":{"kind":"changed","id":"t1","delta":{"tail":{"from":4,"text":"!"}}}}"#.utf8))
        XCTAssertNil(grown.applying(wrong))
    }

    func testSpliceMovesTheTranscriptWindow() throws {
        let view = try snapshotView()
        let patch = try JSONDecoder().decode(MobilePatch.self, from: Data(#"{"thread":{"kind":"changed","id":"t1","delta":{"spliced":{"dropped":1,"kept":1,"messages":[{"kind":"assistant","text":"more","at":3}]},"streamingTail":null}}}"#.utf8))
        let moved = try XCTUnwrap(view.applying(patch))
        XCTAssertEqual(moved.thread?.messages.map(\.text), ["hello", "more"])
        XCTAssertNil(moved.thread?.streamingTail)
        let tooFar = try JSONDecoder().decode(MobilePatch.self, from: Data(#"{"thread":{"kind":"changed","id":"t1","delta":{"spliced":{"dropped":2,"kept":1,"messages":[]}}}}"#.utf8))
        XCTAssertNil(view.applying(tooFar))
    }

    func testNullAndAbsentMeanDifferentThings() throws {
        var view = try snapshotView()
        view.error = "Broken"
        let untouched = try JSONDecoder().decode(MobilePatch.self, from: Data(#"{"groups":[]}"#.utf8))
        XCTAssertEqual(view.applying(untouched)?.error, "Broken")
        let cleared = try JSONDecoder().decode(MobilePatch.self, from: Data(#"{"error":null,"thread":{"kind":"changed","id":"t1","delta":{"changes":null,"status":"idle"}}}"#.utf8))
        let next = try XCTUnwrap(view.applying(cleared))
        XCTAssertNil(next.error)
        XCTAssertNil(next.thread?.changes)
        XCTAssertEqual(next.thread?.status, "idle")
        XCTAssertEqual(next.thread?.title, "Fix tests")
    }

    func testDeltaForAnotherThreadIsIgnored() throws {
        let view = try snapshotView()
        let patch = try JSONDecoder().decode(MobilePatch.self, from: Data(#"{"thread":{"kind":"changed","id":"t9","delta":{"title":"Other"}}}"#.utf8))
        XCTAssertEqual(view.applying(patch)?.thread?.title, "Fix tests")
    }

    func testUnreadableFrameStillCounts() {
        let parsed = parseServerFrame(#"{"kind":"future","sequence":4}"#)
        XCTAssertNil(parsed.message)
        XCTAssertEqual(parsed.sequence, 4)
        XCTAssertNil(parseServerFrame("not json").sequence)
    }

    func testCommandsCarryOnlyWhatWasSet() throws {
        let command = PhoneCommand.send("t1", text: "hi")
        XCTAssertEqual(command.json, .object(["type": .string("task.send"), "taskId": .string("t1"), "text": .string("hi")]))
        let message = MobileClientMessage.command(requestId: "r", command: .fork("t1", worktree: false)).text
        let decoded = try JSONDecoder().decode(JSONValue.self, from: Data(message.utf8))
        XCTAssertEqual(decoded["command"], .object(["type": .string("task.fork"), "taskId": .string("t1")]))
        XCTAssertEqual(decoded["kind"], .string("command"))
    }

    func testResumeSendsWholeNumbers() {
        let text = MobileClientMessage.resume(token: "t", sessionId: nil, lastSequence: 12).text
        XCTAssertTrue(text.contains(#""lastSequence":12"#))
        XCTAssertTrue(text.contains(#""version":\#(mobileProtocolVersion)"#))
        XCTAssertTrue(text.contains(#""oldestComputer":\#(oldestComputerProtocolVersion)"#))
        XCTAssertFalse(text.contains("sessionId"))
    }

    func testPairSaysWhichComputersItReads() {
        let text = MobileClientMessage.pair(code: "c", deviceName: "d").text
        XCTAssertTrue(text.contains(#""version":\#(mobileProtocolVersion)"#))
        XCTAssertTrue(text.contains(#""oldestComputer":\#(oldestComputerProtocolVersion)"#))
    }

    func testClockFieldsTravelAsWholeNumbers() {
        XCTAssertTrue(MobileClientMessage.ping(at: 1_794_115_674_991).text.contains(#""at":1794115674991"#))
        XCTAssertTrue(MobileClientMessage.pong(at: 42).text.contains(#""at":42"#))
    }

    func testPairingLinkReadsTheQRCode() {
        let link = PairingLink("https://mac.tail1234.ts.net/m/#pair=K7M2P9QX")
        XCTAssertEqual(link?.code, "K7M2P9QX")
        XCTAssertEqual(link?.origin.absoluteString, "https://mac.tail1234.ts.net")
        XCTAssertEqual(PairingLink("http://127.0.0.1:47321/m/?pair=k7m2p9qx")?.origin.absoluteString, "http://127.0.0.1:47321")
        XCTAssertEqual(PairingLink("aicodingtool://pair?link=http%3A%2F%2F127.0.0.1%3A5%2Fm%2F%23pair%3DK7M2P9QX")?.code, "K7M2P9QX")
        XCTAssertEqual(PairingLink("aicodingtool://pair?link=https%3A%2F%2Fmac.tail1234.ts.net%2F%23pair%3DK7M2P9QX"), link, "the link the computer draws as its QR")
        XCTAssertNil(PairingLink("https://mac/m/#pair=K7M2P9QU"))
        XCTAssertNil(PairingLink("https://mac/m/"))
        XCTAssertEqual(socketURL(origin: URL(string: "https://mac.ts.net")!)?.absoluteString, "wss://mac.ts.net/m/socket")
        XCTAssertEqual(socketURL(origin: URL(string: "http://127.0.0.1:5")!)?.absoluteString, "ws://127.0.0.1:5/m/socket")
    }

    func testTypedCodeReadsLookalikes() {
        XCTAssertEqual(PairingLink.normalized("k7m2-p9oi l"), "K7M2P901")
    }

    func testToolCallsAndMembersTravel() throws {
        let view = try snapshotView()
        let patch = try JSONDecoder().decode(MobilePatch.self, from: Data(#"{"thread":{"kind":"changed","id":"t1","delta":{"members":[{"id":"m1","title":"Tests","status":"running","computer":"Studio"}],"spliced":{"dropped":0,"kept":2,"messages":[{"kind":"tool","text":"Bash","at":3,"call":{"family":"shell","label":"Bash","argument":"npm test","sigil":"$"}}]}}}}"#.utf8))
        let next = try XCTUnwrap(view.applying(patch))
        XCTAssertEqual(next.thread?.members, [MobileMember(id: "m1", title: "Tests", status: "running", computer: "Studio")])
        XCTAssertEqual(next.thread?.messages.last?.call, MobileToolCall(family: "shell", label: "Bash", argument: "npm test", sigil: "$", verb: nil))
        let emptied = try JSONDecoder().decode(MobilePatch.self, from: Data(#"{"thread":{"kind":"changed","id":"t1","delta":{"members":[]}}}"#.utf8))
        XCTAssertEqual(next.applying(emptied)?.thread?.members, [])
        XCTAssertEqual(Format.summariseTools([next.thread!.messages.last!]), "Bash")
    }

    func testBackgroundWorkTravelsAndStops() throws {
        let view = try snapshotView()
        XCTAssertNil(view.thread?.background)
        let patch = try JSONDecoder().decode(MobilePatch.self, from: Data(#"{"thread":{"kind":"changed","id":"t1","delta":{"background":[{"id":"a1","kind":"agent","title":"Fix tests","detail":"Using Bash","status":"working","live":true,"stoppable":true},{"id":"p1","kind":"shell","title":"npm run dev","detail":"Stopping","status":"working","live":true,"stoppable":true,"stopping":true},{"id":"a2","kind":"agent","title":"Read docs","detail":"Done","status":"completed","live":false,"stoppable":false}]}}}"#.utf8))
        let next = try XCTUnwrap(view.applying(patch))
        XCTAssertEqual(next.thread?.background?.map(\.id), ["a1", "p1", "a2"])
        XCTAssertEqual(next.thread?.background?[1].stopping, true)
        XCTAssertEqual(BackgroundWork.summary(next.thread?.background ?? []), "1 subagent · 1 shell")
        XCTAssertEqual(BackgroundWork.summary([next.thread!.background![2]]), "")
        XCTAssertEqual(PhoneCommand.stopProcess("t1", processId: "a1").json, .object(["type": .string("run.stop-process"), "taskId": .string("t1"), "processId": .string("a1")]))
    }

    func testRoleTravelsAndClears() throws {
        let view = try snapshotView()
        let given = try XCTUnwrap(view.applying(try JSONDecoder().decode(MobilePatch.self, from: Data(#"{"thread":{"kind":"changed","id":"t1","delta":{"role":"reviewer"}}}"#.utf8))))
        XCTAssertEqual(given.thread?.role, "reviewer")
        let cleared = try XCTUnwrap(given.applying(try JSONDecoder().decode(MobilePatch.self, from: Data(#"{"thread":{"kind":"changed","id":"t1","delta":{"role":null}}}"#.utf8))))
        XCTAssertNil(cleared.thread?.role)
        XCTAssertEqual(PhoneCommand.setRole("t1", role: nil).json, .object(["type": .string("task.set-role"), "taskId": .string("t1"), "role": .null]))
        XCTAssertEqual(EngineCatalog(vocabulary: nil, engines: [:]).roles.map(\.id), ["coordinator", "implementer", "reviewer", "researcher"])
    }

    func testDecisionsSuggestionsAndLimitTravelAndClear() throws {
        let view = try snapshotView()
        XCTAssertNil(view.thread?.decisions, "a computer too old to take answers from a phone sends none")
        XCTAssertNil(view.thread?.suggestions)
        XCTAssertNil(view.thread?.limit)
        let json = #"{"thread":{"kind":"changed","id":"t1","delta":{"decisions":[{"taskId":"m1","from":"Storage","id":"d1","question":"Which store?","context":"Both work.","options":[{"label":"SQLite","description":"Local","recommended":true},{"label":"Postgres"}]}],"suggestions":[{"id":"p1","title":"Tests","brief":{"intent":"Cover it","doneWhen":"Green","delivers":"Commits"},"prompt":"Write tests","starting":true}],"limit":{"resetsAt":1800000000000,"window":"session","position":2}}}}"#
        let next = try XCTUnwrap(view.applying(JSONDecoder().decode(MobilePatch.self, from: Data(json.utf8))))
        let decision = try XCTUnwrap(next.thread?.decisions?.first)
        XCTAssertEqual(decision.options.map(\.label), ["SQLite", "Postgres"])
        XCTAssertEqual(decision.options.first?.recommended, true)
        XCTAssertEqual(next.thread?.suggestions?.first?.brief?.delivers, "Commits")
        XCTAssertEqual(next.thread?.suggestions?.first?.starting, true)
        XCTAssertEqual(next.thread?.limit, MobileLimitPause(resetsAt: 1_800_000_000_000, window: "session", position: 2))
        let untouched = try JSONDecoder().decode(MobilePatch.self, from: Data(#"{"thread":{"kind":"changed","id":"t1","delta":{"title":"Renamed"}}}"#.utf8))
        XCTAssertEqual(next.applying(untouched)?.thread?.decisions, next.thread?.decisions)
        let cleared = try XCTUnwrap(next.applying(JSONDecoder().decode(MobilePatch.self, from: Data(#"{"thread":{"kind":"changed","id":"t1","delta":{"decisions":[],"suggestions":[],"limit":null}}}"#.utf8))))
        XCTAssertEqual(cleared.thread?.decisions, [])
        XCTAssertEqual(cleared.thread?.suggestions, [])
        XCTAssertNil(cleared.thread?.limit)

        XCTAssertEqual(PhoneCommand.answerDecision(decision, answer: "SQLite").json, .object(["type": .string("decision.answer"), "taskId": .string("m1"), "decisionId": .string("d1"), "answer": .string("SQLite")]))
        XCTAssertEqual(PhoneCommand.startSuggestion("lead", proposalId: "p1").json, .object(["type": .string("proposal.start"), "taskId": .string("lead"), "proposalId": .string("p1")]))
        XCTAssertEqual(PhoneCommand.resumeLimit("t1").json, .object(["type": .string("limit.resume"), "taskId": .string("t1")]))
        XCTAssertEqual(PhoneCommand.cancelLimit("t1").json, .object(["type": .string("limit.cancel"), "taskId": .string("t1")]))
    }

    func testStopAllQueuedEditAndPairedComputerTravel() throws {
        let view = try snapshotView()
        XCTAssertNil(view.thread?.stoppable, "a computer too old to stop all from a phone never says so")
        let json = #"{"thread":{"kind":"changed","id":"t1","delta":{"stoppable":true,"computer":"Studio","queued":[{"id":"q1","text":"Then docs","editable":true},{"id":"q2","text":"Relayed","origin":"Lead"}],"members":[{"id":"m1","title":"Tests","status":"idle","computer":"Studio","online":false},{"id":"m2","title":"Docs","status":"idle","computer":"Studio"}]}}}"#
        let next = try XCTUnwrap(view.applying(JSONDecoder().decode(MobilePatch.self, from: Data(json.utf8))))
        XCTAssertEqual(next.thread?.stoppable, true)
        XCTAssertEqual(next.thread?.computer, "Studio")
        XCTAssertEqual(next.thread?.queued.map { $0.editable == true }, [true, false])
        XCTAssertEqual(next.thread?.members?.map(\.openable), [false, false], "offline, or from a computer too old to open it")
        let back = try XCTUnwrap(next.applying(JSONDecoder().decode(MobilePatch.self, from: Data(#"{"thread":{"kind":"changed","id":"t1","delta":{"stoppable":false,"members":[{"id":"m1","title":"Tests","status":"idle","computer":"Studio","online":true}]}}}"#.utf8))))
        XCTAssertEqual(back.thread?.stoppable, false)
        XCTAssertEqual(back.thread?.members?.first?.openable, true)
        XCTAssertEqual(back.thread?.computer, "Studio")
        XCTAssertEqual(PhoneCommand.stopAll("lead").json, .object(["type": .string("coordination.stop-all"), "taskId": .string("lead")]))
        XCTAssertEqual(PhoneCommand.editQueued("t1", messageId: "q1").json, .object(["type": .string("task.edit-queued"), "taskId": .string("t1"), "messageId": .string("q1")]))
    }

    func testSnoozeAndArchiveTravel() throws {
        let view = try snapshotView()
        XCTAssertNil(view.archived, "a computer too old to list its archive never says so")
        let json = #"{"archived":3,"activity":{"priority":[{"id":"a","title":"A","projectId":null,"projectName":null,"status":"idle","lastActivityAt":1,"unread":false,"attention":true,"snoozable":true}],"running":[],"threads":[],"snoozed":[{"id":"b","title":"B","projectId":null,"projectName":null,"status":"idle","lastActivityAt":1,"unread":false,"attention":false,"snoozedUntil":1800000000000}]}}"#
        let next = try XCTUnwrap(view.applying(JSONDecoder().decode(MobilePatch.self, from: Data(json.utf8))))
        XCTAssertEqual(next.archived, 3)
        XCTAssertEqual(next.activity.priority.first?.snoozable, true)
        XCTAssertEqual(next.activity.snoozed.first?.snoozedUntil, 1_800_000_000_000)
        XCTAssertEqual(next.applying(try JSONDecoder().decode(MobilePatch.self, from: Data(#"{"groups":[]}"#.utf8)))?.archived, 3)

        let snooze = MobileClientMessage.command(requestId: "r", command: .snooze("a", hours: SnoozeOption.day.hours)).text
        XCTAssertTrue(snooze.contains(#""hours":24"#), snooze)
        XCTAssertEqual(PhoneCommand.unsnooze("b").json, .object(["type": .string("task.unsnooze"), "taskId": .string("b")]))
        XCTAssertEqual(PhoneCommand.restore("c").json, .object(["type": .string("task.restore"), "taskId": .string("c")]))
        XCTAssertEqual(MobileQuery.archived.json, .object(["kind": .string("archived")]))
        let rows = try JSONDecoder().decode([MobileArchivedThread].self, from: Data(#"[{"id":"c","title":"C","projectName":null,"archivedAt":1,"deletesAt":432000001}]"#.utf8))
        XCTAssertEqual(rows.first?.deletesAt, 432_000_001)
    }

    func testSnapshotNamesTheComputer() {
        let frame = snapshotFrame().replacingOccurrences(of: #""instance":"one""#, with: #""instance":"one","computer":"Studio""#)
        guard case .snapshot(_, _, _, _, _, let computer, _)? = parseServerFrame(frame).message else { return XCTFail("snapshot did not parse") }
        XCTAssertEqual(computer, "Studio")
    }

    func testCoordinatorProjectAndFolderShapes() throws {
        XCTAssertEqual(PhoneCommand.setCoordinator(nil, true).json, .object(["type": .string("task.set-role"), "role": .string("coordinator")]))
        XCTAssertEqual(PhoneCommand.setCoordinator("t1", false).json, .object(["type": .string("task.set-role"), "taskId": .string("t1"), "role": .null]))
        XCTAssertEqual(PhoneCommand.addProject("~/code/app").json, .object(["type": .string("project.add"), "root": .string("~/code/app"), "start": .bool(true)]))
        XCTAssertEqual(MobileQuery.directories(prefix: "~/").json, .object(["kind": .string("directories"), "prefix": .string("~/")]))
    }

    func testPairedComputerIsNamedByItselfElseItsHost() {
        let credential = MobileCredential(token: "t", deviceId: "d", deviceName: "iPhone")
        XCTAssertEqual(PairedComputer(origin: URL(string: "https://studio.tail1234.ts.net")!, credential: credential).title, "studio")
        XCTAssertEqual(PairedComputer(origin: URL(string: "http://127.0.0.1:7738")!, credential: credential).title, "127.0.0.1")
        XCTAssertEqual(PairedComputer(origin: URL(string: "https://studio.ts.net")!, credential: credential, name: "Studio").title, "Studio")
    }

    func testPicturesTravelWithTheirWords() {
        guard case .object(let command) = PhoneCommand.message("t1", text: "Look", sources: ["data:image/png;base64,AAAA"], steer: true).json else { return XCTFail("not an object") }
        XCTAssertEqual(command["type"], .string("attachments.send"))
        XCTAssertEqual(command["text"], .string("Look"))
        XCTAssertEqual(command["steer"], .bool(true))
        guard case .array(let attachments) = command["attachments"], case .object(let picture) = attachments.first else { return XCTFail("no attachments") }
        XCTAssertEqual(picture["source"], .string("data:image/png;base64,AAAA"))
        XCTAssertEqual(picture["annotations"], .array([]))
        XCTAssertNil(picture["path"], "a phone never names a file on the computer")
        XCTAssertEqual(PhoneCommand.message("t1", text: "Hi", sources: []).json, PhoneCommand.send("t1", text: "Hi").json, "words alone stay a plain send")
        XCTAssertNil(PhoneCommand.sendImages(nil, text: "", sources: ["data:image/png;base64,AAAA"]).json["text"], "a picture alone carries no empty words")
    }
}
