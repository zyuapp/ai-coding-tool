import Foundation

/// The oldest computer this app reads. Raised only when an older computer would leave out what the app needs.
let oldestComputerProtocolVersion = 8

/// A field a patch may leave out, set, or set to null: absent and null mean different things.
enum PatchField<Value: Equatable & Sendable>: Equatable, Sendable {
    case absent
    case set(Value)

    func applied(to current: Value) -> Value {
        if case .set(let value) = self { return value }
        return current
    }
}

extension KeyedDecodingContainer {
    func patchField<T: Decodable & Equatable & Sendable>(_ type: T.Type, forKey key: Key) throws -> PatchField<T?> {
        guard contains(key) else { return .absent }
        if try decodeNil(forKey: key) { return .set(nil) }
        return .set(try decode(T.self, forKey: key))
    }

    func patchValue<T: Decodable & Equatable & Sendable>(_ type: T.Type, forKey key: Key) throws -> PatchField<T> {
        guard contains(key), try !decodeNil(forKey: key) else { return .absent }
        return .set(try decode(T.self, forKey: key))
    }
}

extension MobileView {
    /// The view after `patch`, or nil when the patch does not fit the view it was meant for, which
    /// means a frame was lost and the phone must start over from a snapshot.
    func applying(_ patch: MobilePatch) -> MobileView? {
        var next = applyingFields(patch)
        switch patch.thread {
        case nil: break
        case .closed: next.thread = nil
        case .opened(let thread): next.thread = thread
        case .changed(let id, let delta):
            guard let current = thread, current.id == id else { break }
            guard let changed = current.applying(delta) else { return nil }
            next.thread = changed
        }
        return next
    }
}

extension MobileThreadView {
    func applying(_ delta: MobileThreadDelta) -> MobileThreadView? {
        var next = applyingFields(delta)
        if let spliced = delta.spliced {
            guard messages.count >= spliced.dropped + spliced.kept else { return nil }
            next.messages = Array(messages[spliced.dropped..<(spliced.dropped + spliced.kept)]) + spliced.messages
        }
        if let tail = delta.tail {
            // The server counts the tail in UTF-16 code units, as JavaScript strings do.
            guard streamingTail?.utf16.count == tail.from else { return nil }
            next.streamingTail = (streamingTail ?? "") + tail.text
        }
        return next
    }
}

extension MobileServerMessage {
    struct AnswerError: Error, Equatable, Sendable {
        var message: String
    }
}

/// A frame as a message, or, for one this app cannot read, at least where it sat in the numbering.
func parseServerFrame(_ text: String) -> (message: MobileServerMessage?, sequence: Int?) {
    guard let data = text.data(using: .utf8), let root = try? JSONDecoder().decode(JSONValue.self, from: data), let object = root.objectValue else { return (nil, nil) }
    let sequence: Int? = {
        guard case .number(let value) = object["sequence"], value >= 0, value.rounded() == value else { return nil }
        return Int(value)
    }()
    guard let sequence, let kind = object["kind"]?.stringValue else { return (nil, nil) }
    guard let message = MobileServerMessage.read(kind: kind, sequence: sequence, object) else { return (nil, sequence > 0 ? sequence : nil) }
    return (message, sequence)
}

extension PhonePush {
    typealias Environment = PushEnvironment
}

extension MobileClientMessage {
    var text: String {
        (try? String(decoding: JSONEncoder().encode(json), as: UTF8.self)) ?? "{}"
    }
}
