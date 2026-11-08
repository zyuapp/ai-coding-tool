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
        guard case .snapshot(_, _, let view, _, _, _)? = frame(snapshotFrame()) else { throw XCTSkip("snapshot did not parse") }
        return view
    }

    func testSnapshotDecodes() throws {
        guard case .snapshot(let sequence, let session, let view, let instance, let vocabulary, let computer)? = frame(snapshotFrame()) else { return XCTFail("snapshot did not parse") }
        XCTAssertEqual(sequence, 1)
        XCTAssertEqual(session, "s1")
        XCTAssertEqual(instance, "one")
        XCTAssertEqual(view.thread?.location, .worktree(name: "wt", threads: 2))
        XCTAssertEqual(view.thread?.branchRange, .branches(base: "main", compare: nil))
        XCTAssertEqual(vocabulary?.engines.first?.models.first?.efforts, ["max", "high"])
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

    func testSnapshotNamesTheComputer() {
        let frame = snapshotFrame().replacingOccurrences(of: #""instance":"one""#, with: #""instance":"one","computer":"Studio""#)
        guard case .snapshot(_, _, _, _, _, let computer)? = parseServerFrame(frame).message else { return XCTFail("snapshot did not parse") }
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
