import Foundation

/// What a tool is about to do, read from its input so the user approves an action rather than a blob of JSON.
enum ApprovalPreview: Equatable, Sendable {
    case command(String)
    /// A file written whole.
    case file(path: String, content: String)
    /// Lines taken out of a file and the lines put in their place.
    case edit(path: String, removed: [String], added: [String])
    case raw(String)

    init(detail: String) {
        guard let data = detail.data(using: .utf8), case .object(let input)? = try? JSONDecoder().decode(JSONValue.self, from: data) else {
            self = .raw(detail)
            return
        }
        func text(_ keys: String...) -> String? {
            for key in keys {
                if case .string(let value)? = input[key], !value.isEmpty { return value }
            }
            return nil
        }
        let path = text("file_path", "filePath", "notebook_path", "path")
        if let path, let removed = text("old_string", "oldString"), let added = input["new_string"] ?? input["newString"], case .string(let added) = added {
            self = .edit(path: path, removed: Self.lines(removed), added: added.isEmpty ? [] : Self.lines(added))
        } else if let path, let content = text("content") {
            self = .file(path: path, content: content)
        } else if let command = text("command") {
            self = .command(command)
        } else {
            self = .raw(detail)
        }
    }

    private static func lines(_ text: String) -> [String] {
        text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
    }

    /// The file acted on, by its name alone.
    var subject: String? {
        switch self {
        case .file(let path, _), .edit(let path, _, _): path.split(separator: "/").last.map(String.init)
        case .command, .raw: nil
        }
    }

    /// The text copied or selected from the preview.
    var plain: String {
        switch self {
        case .command(let command): command
        case .file(_, let content): content
        case .edit(_, let removed, let added): (removed.map { "-\($0)" } + added.map { "+\($0)" }).joined(separator: "\n")
        case .raw(let detail): detail
        }
    }
}
