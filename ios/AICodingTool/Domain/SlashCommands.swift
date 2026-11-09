import Foundation

/// One of the engine's slash commands or enabled skills, as the desktop's "/" menu lists it.
struct SlashCommand: Decodable, Equatable, Identifiable, Sendable {
    var name: String
    var description: String
    var argumentHint: String
    var aliases: [String]?

    var id: String { name }

    /// The description's first sentence, so a row stays short.
    var summary: String {
        let trimmed = description.trimmingCharacters(in: .whitespacesAndNewlines)
        let end = trimmed.range(of: #"[.!?](\s|$)"#, options: .regularExpression)
        var sentence = end.map { String(trimmed[..<$0.lowerBound]) + String(trimmed[$0].prefix(1)) } ?? trimmed
        if let parenthesis = sentence.range(of: #"\s+\([^)]*\)[.!?]?$"#, options: .regularExpression) { sentence.removeSubrange(parenthesis) }
        return sentence
    }
}

/// What the computer answers for a "/" menu: its commands, or why it has none to give.
struct CommandDiscovery: Decodable, Sendable {
    var status: String
    var commands: [SlashCommand]?
}

enum SlashCommands {
    /// What follows the "/" that starts the draft, while it is still one word; nil once there is none.
    static func query(in draft: String) -> String? {
        guard draft.hasPrefix("/") else { return nil }
        let word = draft.dropFirst()
        guard !word.contains(where: { $0.isWhitespace || $0 == "/" }) else { return nil }
        return word.lowercased()
    }

    /// The commands whose name or an alias starts with the query, in the computer's order.
    static func matching(_ commands: [SlashCommand], _ query: String) -> [SlashCommand] {
        commands.filter { command in
            command.name.lowercased().hasPrefix(query) || (command.aliases ?? []).contains { $0.lowercased().hasPrefix(query) }
        }
    }

    /// The draft once a command is picked, ready for its arguments.
    static func inserting(_ command: SlashCommand) -> String { "/\(command.name) " }
}
