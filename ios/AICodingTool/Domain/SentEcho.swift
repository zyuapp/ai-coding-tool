import Foundation

/// Words just sent that reappear in the composer. Dictation still running when Send is tapped
/// commits its final text after the composer clears, so the sent words come back.
struct SentEcho {
    static let window: TimeInterval = 3

    let text: String
    let until: Date

    init(_ text: String, at now: Date = Date()) {
        self.text = Self.normalized(text)
        until = now.addingTimeInterval(Self.window)
    }

    /// Whether `draft` is the sent words again: the same letters and digits, ignoring case,
    /// spacing and the punctuation dictation adds when it finishes.
    func matches(_ draft: String, at now: Date = Date()) -> Bool {
        now < until && !text.isEmpty && Self.normalized(draft) == text
    }

    private static func normalized(_ text: String) -> String {
        String(text.lowercased().unicodeScalars.filter(CharacterSet.alphanumerics.contains).map(Character.init))
    }
}
