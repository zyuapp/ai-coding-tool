@testable import AICodingTool
import Security
import XCTest

final class StorageTests: XCTestCase {
    private var storage: PhoneStorage!
    private var suite: String!

    override func setUp() {
        suite = "aicodingtool.tests.\(UUID().uuidString)"
        storage = PhoneStorage(defaults: UserDefaults(suiteName: suite)!, keychainService: suite)
    }

    override func tearDown() {
        for account in ["paired-computer", "paired-computers"] { SecItemDelete(item(account) as CFDictionary) }
        UserDefaults().removePersistentDomain(forName: suite)
    }

    private func item(_ account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: suite!, kSecAttrAccount as String: account]
    }

    private func stored(_ account: String) -> Data? {
        var request = item(account)
        request[kSecReturnData as String] = true
        var result: AnyObject?
        return SecItemCopyMatching(request as CFDictionary, &result) == errSecSuccess ? result as? Data : nil
    }

    private let origin = URL(string: "https://studio.ts.net")!
    private var computer: PairedComputer { PairedComputer(origin: origin, credential: MobileCredential(token: "t", deviceId: "d", deviceName: "iPhone")) }

    func testAPhonePairedBeforeSeveralComputersKeepsItsPairingOutboxAndNames() throws {
        // What the version with one computer left behind: the pairing, the computer it dialled, its outbox and its vocabulary.
        XCTAssertEqual(SecItemAdd(item("paired-computer").merging([kSecValueData as String: try JSONEncoder().encode(computer)]) { _, new in new } as CFDictionary, nil), errSecSuccess)
        storage.origin = origin
        let owed = OutboxEntry(requestId: "r1", command: .send("t1", text: "hi"), sent: false, queuedAt: 1, writes: 0)
        storage.defaults.set(try JSONEncoder().encode([owed]), forKey: "aicodingtool.mobile.outbox")
        let vocabulary = MobileVocabulary(engines: [], efforts: [MobileEffortTerm(id: "high", label: "High")])
        storage.defaults.set(try JSONEncoder().encode(vocabulary), forKey: "aicodingtool.mobile.vocabulary")

        XCTAssertEqual(storage.readComputers(), [computer])
        XCTAssertNil(stored("paired-computer"), "the old item goes once the list holds it")
        XCTAssertNotNil(stored("paired-computers"))
        XCTAssertEqual(storage.readComputers(), [computer], "and the list is read from then on")
        XCTAssertEqual(storage.readOutbox(for: origin), [owed])
        XCTAssertEqual(storage.vocabulary(for: origin), vocabulary)
        XCTAssertEqual(storage.readOutbox(for: URL(string: "https://laptop.ts.net")), [], "another computer owes nothing")
        XCTAssertNil(storage.vocabulary(for: URL(string: "https://laptop.ts.net")))

        storage.writeOutbox([], for: origin)
        XCTAssertEqual(storage.readOutbox(for: origin), [], "the old outbox is let go once this computer's own is written")
    }

    func testComputersAreKeptAndForgotten() {
        let laptop = PairedComputer(origin: URL(string: "https://laptop.ts.net")!, credential: MobileCredential(token: "u", deviceId: "e", deviceName: "iPhone"), name: "Laptop")
        XCTAssertTrue(storage.writeComputers([computer, laptop]))
        XCTAssertEqual(storage.readComputers(), [computer, laptop])
        XCTAssertTrue(storage.writeComputers([]))
        XCTAssertEqual(storage.readComputers(), [])
    }
}
