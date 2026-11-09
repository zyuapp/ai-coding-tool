@testable import AICodingTool
import XCTest

final class DomainTests: XCTestCase {
    private func message(_ kind: String, _ text: String, at: Double = 0) -> MobileMessage {
        MobileMessage(kind: kind, text: text, origin: nil, at: at)
    }

    func testToolRunsBecomeOneBlock() {
        let blocks = Format.transcriptBlocks([message("user", "go"), message("tool", "Bash"), message("tool", "Read"), message("assistant", "one"), message("tool", "Bash"), message("assistant", "two")])
        XCTAssertEqual(blocks.count, 5)
        guard case .tools(_, let calls) = blocks[1] else { return XCTFail("expected a tool run") }
        XCTAssertEqual(calls.count, 2)
        guard case .message(_, _, let firstAnswer) = blocks[2], case .message(_, _, let lastAnswer) = blocks[4] else { return XCTFail("expected replies") }
        XCTAssertFalse(firstAnswer, "a reply with another reply after its tools does not close the turn")
        XCTAssertTrue(lastAnswer)
        let twoReplies = Format.transcriptBlocks([message("assistant", "a"), message("assistant", "b")])
        guard case .message(_, _, let early) = twoReplies[0] else { return XCTFail("expected a reply") }
        XCTAssertFalse(early)
    }

    func testLatestAnswerIsTheLastTurnsReply() {
        let blocks = Format.transcriptBlocks([message("user", "go"), message("assistant", "one", at: 1), message("user", "more", at: 2), message("assistant", "two", at: 3), message("tool", "Bash", at: 4)])
        XCTAssertEqual(Format.latestAnswer(blocks), blocks[3].id)
        XCTAssertNil(Format.latestAnswer(Format.transcriptBlocks([message("user", "go")])))
        let window = [message("user", "go", at: 1), message("assistant", "one", at: 2), message("assistant", "two", at: 3)]
        XCTAssertEqual(Format.transcriptBlocks(Array(window.dropFirst()), omitted: 1).map(\.id), Array(Format.transcriptBlocks(window).map(\.id).dropFirst()), "a block keeps its key as the window slides")
    }

    func testToolSummaryCountsCommonestFirst() {
        let calls = ["Read", "Bash", "Bash", "mcp__aicodingtool-threads__read_thread", "mcp__github__get_issue"].map { message("tool", $0) }
        XCTAssertEqual(Format.summariseTools(calls), "Bash ×2, Read, Read thread, github · get issue")
        XCTAssertEqual(ToolNames.family(engine: "claude", "Bash"), .shell)
        XCTAssertEqual(ToolNames.family(engine: "codex", "browser_open"), .web)
        XCTAssertEqual(ToolNames.family(engine: "future", "Grep"), .other)
    }

    func testRelativeTime() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        let at = now.timeIntervalSince1970 * 1000
        XCTAssertEqual(Format.relativeTime(at - 30_000, now: now), "now")
        XCTAssertEqual(Format.relativeTime(at - 5 * 60_000, now: now), "5m")
        XCTAssertEqual(Format.relativeTime(at - 3 * 3_600_000, now: now), "3h")
        XCTAssertEqual(Format.relativeTime(at - 2 * 86_400_000, now: now), "2d")
    }

    func testThreadMeta() {
        var entry = MobileThreadEntry(id: "t", title: "T", projectId: nil, projectName: nil, status: "running", lastActivityAt: 1_000_000, unread: false, outcome: nil, headline: nil, waiting: nil, attention: false)
        XCTAssertEqual(Format.stateLabel(entry), "Working")
        entry.status = "idle"
        entry.outcome = "failed"
        XCTAssertEqual(Format.stateLabel(entry), "Failed")
        entry.outcome = nil
        XCTAssertNil(Format.stateLabel(entry))
    }

    func testDiffRows() {
        let patch = """
        diff --git a/a.txt b/a.txt
        --- a/a.txt
        +++ b/a.txt
        @@ -1,2 +1,2 @@ title
         same
        -old
        +new
        \\ No newline at end of file
        @@ -10 +10 @@
        -x
        +y

        """
        let rows = Diff.rows(patch)
        XCTAssertEqual(rows.map(\.kind), [.hunk, .context, .delete, .add, .hunk, .delete, .add])
        XCTAssertEqual(rows[0].text, "@@ -1,2 +1,2 @@ title")
        XCTAssertEqual(rows[4].text, "@@ -10,1 +10,1 @@")
        XCTAssertEqual(rows[2].oldLine, 2)
        XCTAssertEqual(rows[3].newLine, 2)
        XCTAssertEqual(Set(rows.map(\.id)).count, rows.count)
    }

    func testMatchingRanksStartsBeforeWordsBeforeAnywhere() {
        let names = ["my-app", "app", "zapper", "web"]
        XCTAssertEqual(Matching.ranked(names, query: "app") { $0 }, ["app", "my-app", "zapper"])
        XCTAssertEqual(Matching.ranked(names, query: " ") { $0 }, names)
    }

    private var catalog: EngineCatalog {
        let vocabulary = MobileVocabulary(
            engines: [
                MobileEngineTerms(id: "claude", label: "Claude", fastMode: false, policies: [MobilePolicyTerm(id: "confirm", label: "Confirm", description: "")], models: [MobileModel(id: "opus", label: "Opus", description: "", provider: nil, efforts: ["max", "high", "low"]), MobileModel(id: "haiku", label: "Haiku", description: "", provider: nil, efforts: [])]),
                MobileEngineTerms(id: "codex", label: "Codex", fastMode: true, policies: [], models: [MobileModel(id: "sol", label: "Sol", description: "", provider: nil, efforts: ["ultra", "high"])]),
            ],
            efforts: ["ultra", "max", "xhigh", "high", "medium", "low"].map { MobileEffortTerm(id: $0, label: $0.capitalized, description: nil, delegates: $0 == "ultra" ? true : nil) }
        )
        return EngineCatalog(vocabulary: vocabulary, engines: ["codex": MobileEngine(access: "ready", models: nil, catalog: [MobileModel(id: "terra", label: "Terra", description: "", provider: "OpenAI", efforts: ["high"])])])
    }

    func testEffortClampsToTheNearestShallower() {
        XCTAssertEqual(catalog.effortForModel("claude", model: "opus", effort: "xhigh", coordinating: false), "high")
        XCTAssertEqual(catalog.effortForModel("claude", model: "opus", effort: "medium", coordinating: false), "low")
        XCTAssertEqual(catalog.effortForModel("claude", model: "haiku", effort: "high", coordinating: false), "high")
        XCTAssertEqual(catalog.efforts("codex", model: "terra", coordinating: true).map(\.id), ["high"])
    }

    func testSentCatalogStandsForTheBuiltInOne() {
        XCTAssertEqual(catalog.models("codex").map(\.id), ["terra"])
        let library = catalog.library(engine: "claude", locked: true)
        XCTAssertEqual(library.map(\.key), ["claude", "codex:OpenAI"])
        XCTAssertEqual(library.map(\.locked), [false, true])
    }

    func testSettingsSummary() {
        let summary = catalog.summary(MobileThreadSettings(engine: "codex", model: "terra", effort: "max", fastMode: true, policy: "confirm", coordinating: nil))
        XCTAssertEqual(summary.mode, "Confirm")
        XCTAssertEqual(summary.model, "Terra · Fast")
        XCTAssertEqual(summary.effort, "High")
        XCTAssertNil(catalog.summary(MobileThreadSettings(engine: "claude", model: "haiku", effort: "high", fastMode: nil, policy: "bypass", coordinating: nil)).effort)
    }

    func testDictationTraceSeesWordsAtATimeForAWhile() {
        let now = Date()
        var trace = DictationTrace()
        trace.record(from: "", to: "f", at: now)
        trace.record(from: "f", to: "fi", at: now)
        XCTAssertFalse(trace.recent(at: now), "typing adds one character")
        trace.record(from: "fix", to: "fi", at: now)
        XCTAssertFalse(trace.recent(at: now))
        trace.record(from: "fix", to: "fix the build", at: now)
        XCTAssertTrue(trace.recent(at: now.addingTimeInterval(DictationTrace.window - 0.1)))
        XCTAssertFalse(trace.recent(at: now.addingTimeInterval(DictationTrace.window)))
        trace.reset()
        XCTAssertFalse(trace.recent(at: now))
    }

    func testMiddleTruncationKeepsBothEnds() {
        XCTAssertEqual(Format.middleTruncated("payments-reconciliation-service-backend", limit: 26), "payments-reco…vice-backend")
        XCTAssertEqual(Format.middleTruncated("payments-reconciliation-service-backend", limit: 26).count, 26)
        XCTAssertEqual(Format.middleTruncated("qa-rel", limit: 26), "qa-rel")
        XCTAssertEqual(Format.middleTruncated("abcdef", limit: 6), "abcdef")
    }

    func testUsageResetNamesTheDayOnlyPastToday() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let now = ISO8601DateFormatter().date(from: "2027-01-15T10:00:00Z")!
        let today = Format.usageReset("2027-01-15T16:10:00.123456+00:00", now: now, calendar: calendar)
        XCTAssertNotNil(today)
        XCTAssertTrue(today!.hasPrefix("Resets "))
        XCTAssertFalse(today!.contains("Jan"))
        let later = Format.usageReset("2027-01-20T09:00:00Z", now: now, calendar: calendar)
        XCTAssertTrue(later?.contains("Jan 20 at") == true, later ?? "nil")
        XCTAssertNil(Format.usageReset(nil, now: now, calendar: calendar))
        XCTAssertNil(Format.usageReset("soon", now: now, calendar: calendar))
    }

    func testLimitSaysWhenItLiftsAndWhereTheThreadStands() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let now = ISO8601DateFormatter().date(from: "2027-01-15T10:00:00Z")!
        let soon = now.timeIntervalSince1970 * 1000 + 3_600_000
        let first = Format.limitLabel(MobileLimitPause(resetsAt: soon, window: "session", position: 1), now: now, calendar: calendar)
        XCTAssertTrue(first.hasPrefix("Usage limit reached. Resumes at "), first)
        XCTAssertFalse(first.contains("after"))
        XCTAssertTrue(Format.limitLabel(MobileLimitPause(resetsAt: soon, window: "session", position: 3), now: now, calendar: calendar).hasSuffix(" after 2 other threads."))
        XCTAssertEqual(Format.limitLabel(MobileLimitPause(resetsAt: soon - 7_200_000, window: "session", position: 2), now: now, calendar: calendar), "Usage limit reset. Resuming after 1 other thread.")
        let weekly = Format.limitLabel(MobileLimitPause(resetsAt: soon + 3 * 86_400_000, window: "weekly", position: nil), now: now, calendar: calendar)
        XCTAssertTrue(weekly.hasPrefix("Weekly usage limit reached. Resets Mon "), weekly)
        XCTAssertEqual(Format.limitLabel(MobileLimitPause(resetsAt: soon - 7_200_000, window: "weekly", position: nil), now: now, calendar: calendar), "Weekly usage limit reset.")
    }

    func testArchiveSaysWhenItDeletesAndWhereItIsRestored() {
        let now = Date(timeIntervalSince1970: 1_000)
        let at = now.timeIntervalSince1970 * 1000
        XCTAssertEqual(Format.deletesIn(at + 4.2 * 86_400_000, now: now), "Deletes in 5 days")
        XCTAssertEqual(Format.deletesIn(at + 3_600_000, now: now), "Deletes in 1 day")
        XCTAssertEqual(Format.deletesIn(at - 1, now: now), "Deletes on next launch")
        XCTAssertTrue(Format.archiveConsequence(running: false, restorable: true).hasSuffix("Restore it from Archived within 5 days."))
        XCTAssertTrue(Format.archiveConsequence(running: true, restorable: false).contains("on your computer"))
    }

    func testSlashMenuOpensOnlyForTheDraftsFirstWord() {
        XCTAssertEqual(SlashCommands.query(in: "/Rev"), "rev")
        XCTAssertEqual(SlashCommands.query(in: "/"), "")
        XCTAssertNil(SlashCommands.query(in: "/review now"), "arguments close it")
        XCTAssertNil(SlashCommands.query(in: "/tmp/file"), "a path is not a command")
        XCTAssertNil(SlashCommands.query(in: "see /review"))
        let commands = [SlashCommand(name: "code-review", description: "", argumentHint: "", aliases: ["review"]), SlashCommand(name: "visualize", description: "", argumentHint: "")]
        XCTAssertEqual(SlashCommands.matching(commands, "rev").map(\.name), ["code-review"], "an alias matches")
    }
}
