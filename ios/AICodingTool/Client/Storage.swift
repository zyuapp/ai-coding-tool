import Foundation
import Security

/// A computer this phone is paired with: where it is, what it calls itself, and the token that gets the phone back in.
struct PairedComputer: Codable, Equatable, Identifiable, Sendable {
    /// The origin the pairing link named, such as `https://mac.tailnet.ts.net`.
    var origin: URL
    var credential: MobileCredential
    /// What the computer calls itself, once it has said. Older computers never do.
    var name: String?

    var id: URL { origin }

    /// The computer's own name, else the first label of its name on the network, else its address.
    var title: String {
        if let name, !name.isEmpty { return name }
        let host = origin.host() ?? origin.absoluteString
        guard host.contains(where: \.isLetter) else { return host }
        return host.split(separator: ".").first.map(String.init) ?? host
    }

    /// Where the computer is reached: its host, and its port when the link named one.
    var address: String {
        let host = origin.host() ?? origin.absoluteString
        return origin.port.map { "\(host):\($0)" } ?? host
    }
}

/// What the phone keeps between launches. The token lives in the Keychain; the rest is preferences.
struct PhoneStorage {
    var defaults: UserDefaults = .standard
    var keychainService = "com.zyuapp.aicodingtool.phone"

    private static let computerAccount = "paired-computer"
    private static let computersAccount = "paired-computers"
    private static let outboxKey = "aicodingtool.mobile.outbox"
    private static let foldedKey = "aicodingtool.mobile.folded"
    private static let activityProjectKey = "aicodingtool.mobile.activity-project"
    private static let themeKey = "aicodingtool.mobile.theme"
    private static let vocabularyKey = "aicodingtool.mobile.vocabulary"
    private static let originKey = "aicodingtool.mobile.origin"

    /// Every computer this phone is paired with. A phone from before it paired with several holds one, which is read as the list.
    func readComputers() -> [PairedComputer] {
        if let data = keychainRead(account: Self.computersAccount), let computers = try? JSONDecoder().decode([PairedComputer].self, from: data) { return computers }
        guard let data = keychainRead(account: Self.computerAccount), let computer = try? JSONDecoder().decode(PairedComputer.self, from: data) else { return [] }
        // The old item goes only once the list holding it reads back, so a failed write leaves the pairing where it was.
        if writeComputers([computer]), let moved = keychainRead(account: Self.computersAccount), (try? JSONDecoder().decode([PairedComputer].self, from: moved)) == [computer] {
            keychainDelete(account: Self.computerAccount)
        }
        return [computer]
    }

    /// Whether the list was kept.
    @discardableResult
    func writeComputers(_ computers: [PairedComputer]) -> Bool {
        guard !computers.isEmpty, let data = try? JSONEncoder().encode(computers) else {
            keychainDelete(account: Self.computersAccount)
            return true
        }
        return keychainWrite(data, account: Self.computersAccount)
    }

    /// The computer the app last dialled, kept apart from the token so a forgotten token still knows where to pair again.
    var origin: URL? {
        get { defaults.string(forKey: Self.originKey).flatMap(URL.init(string:)) }
        nonmutating set { defaults.set(newValue?.absoluteString, forKey: Self.originKey) }
    }

    /// What is still owed to one computer. The phone from before several computers kept a single outbox, which belongs to the computer it last dialled.
    func readOutbox(for origin: URL?) -> [OutboxEntry] {
        let key = Self.outboxKey(origin)
        let data = defaults.data(forKey: key) ?? (origin == self.origin ? defaults.data(forKey: Self.outboxKey) : nil)
        guard let data, let entries = try? JSONDecoder().decode([LenientEntry].self, from: data) else { return [] }
        return entries.compactMap(\.entry)
    }

    func writeOutbox(_ outbox: [OutboxEntry], for origin: URL?) {
        defaults.removeObject(forKey: Self.outboxKey)
        let key = Self.outboxKey(origin)
        if outbox.isEmpty {
            defaults.removeObject(forKey: key)
        } else if let data = try? JSONEncoder().encode(outbox) {
            defaults.set(data, forKey: key)
        }
    }

    private static func outboxKey(_ origin: URL?) -> String {
        "\(outboxKey).\(origin?.absoluteString ?? "none")"
    }

    var folded: Set<String> {
        get { Set(defaults.stringArray(forKey: Self.foldedKey) ?? []) }
        nonmutating set { defaults.set(newValue.sorted(), forKey: Self.foldedKey) }
    }

    var activityProject: String? {
        get { defaults.string(forKey: Self.activityProjectKey) }
        nonmutating set {
            if let newValue, !newValue.isEmpty { defaults.set(newValue, forKey: Self.activityProjectKey) } else { defaults.removeObject(forKey: Self.activityProjectKey) }
        }
    }

    var theme: MobileTheme? {
        get { defaults.data(forKey: Self.themeKey).flatMap { try? JSONDecoder().decode(MobileTheme.self, from: $0) } }
        nonmutating set { defaults.set(newValue.flatMap { try? JSONEncoder().encode($0) }, forKey: Self.themeKey) }
    }

    /// What one computer's build calls its engines, modes, models and efforts.
    func vocabulary(for origin: URL?) -> MobileVocabulary? {
        let data = defaults.data(forKey: "\(Self.vocabularyKey).\(origin?.absoluteString ?? "none")") ?? (origin == self.origin ? defaults.data(forKey: Self.vocabularyKey) : nil)
        return data.flatMap { try? JSONDecoder().decode(MobileVocabulary.self, from: $0) }
    }

    func writeVocabulary(_ vocabulary: MobileVocabulary?, for origin: URL?) {
        defaults.removeObject(forKey: Self.vocabularyKey)
        defaults.set(vocabulary.flatMap { try? JSONEncoder().encode($0) }, forKey: "\(Self.vocabularyKey).\(origin?.absoluteString ?? "none")")
    }

    /// An outbox entry read back, or nil for one a different version wrote in a shape this one cannot send.
    private struct LenientEntry: Decodable {
        var entry: OutboxEntry?

        init(from decoder: Decoder) throws {
            entry = try? OutboxEntry(from: decoder)
        }
    }

    private func query(account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: keychainService, kSecAttrAccount as String: account]
    }

    private func keychainRead(account: String) -> Data? {
        var request = query(account: account)
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        guard SecItemCopyMatching(request as CFDictionary, &result) == errSecSuccess else { return nil }
        return result as? Data
    }

    private func keychainWrite(_ data: Data, account: String) -> Bool {
        let attributes: [String: Any] = [kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        let updated = SecItemUpdate(query(account: account) as CFDictionary, attributes as CFDictionary)
        guard updated == errSecItemNotFound else { return updated == errSecSuccess }
        return SecItemAdd(query(account: account).merging(attributes) { _, new in new } as CFDictionary, nil) == errSecSuccess
    }


    private func keychainDelete(account: String) {
        SecItemDelete(query(account: account) as CFDictionary)
    }
}

/// A pairing link as the computer's QR code writes it: `aicodingtool://pair?link=` around `https://host/#pair=CODE`.
struct PairingLink: Equatable, Sendable {
    static let codeLength = 8
    private static let alphabet = CharacterSet(charactersIn: "0123456789ABCDEFGHJKMNPQRSTVWXYZ")

    var origin: URL
    var code: String

    /// The link out of what was scanned, pasted or opened: the computer's own link, or this app's
    /// `aicodingtool://pair?link=` wrapper around it.
    init?(_ text: String) {
        var raw = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if let wrapped = URLComponents(string: raw), wrapped.scheme == "aicodingtool", let link = wrapped.queryItems?.first(where: { $0.name == "link" })?.value {
            raw = link
        }
        guard let url = URLComponents(string: raw), let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http", let host = url.host, !host.isEmpty else { return nil }
        let fromFragment = url.fragment.flatMap { fragment in URLComponents(string: "?\(fragment)")?.queryItems?.first { $0.name == "pair" }?.value }
        let fromQuery = url.queryItems?.first { $0.name == "pair" }?.value
        guard let code = PairingLink.code(fromFragment ?? fromQuery ?? "") else { return nil }
        var origin = URLComponents()
        origin.scheme = scheme
        origin.host = host
        origin.port = url.port
        guard let originURL = origin.url else { return nil }
        self.origin = originURL
        self.code = code
    }

    /// What was typed, as a code: upper case, without spaces or dashes, and lookalike letters read as the digits they stand for.
    static func normalized(_ text: String) -> String {
        let cleaned = text.uppercased().filter { $0 != " " && $0 != "-" }.map { character -> Character in
            switch character {
            case "O": "0"
            case "I", "L": "1"
            default: character
            }
        }
        return String(cleaned.prefix(codeLength))
    }

    static func code(_ text: String) -> String? {
        let code = text.trimmingCharacters(in: .whitespaces).uppercased()
        guard code.count == codeLength, code.unicodeScalars.allSatisfy(alphabet.contains) else { return nil }
        return code
    }
}

/// The socket the phone talks on, under the computer's phone path.
func socketURL(origin: URL) -> URL? {
    guard var components = URLComponents(url: origin, resolvingAgainstBaseURL: false) else { return nil }
    components.scheme = components.scheme == "https" ? "wss" : "ws"
    components.path = "/m/socket"
    components.query = nil
    components.fragment = nil
    return components.url
}
