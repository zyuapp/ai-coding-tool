import Foundation

/// One drawn line of a patch, ported from `src/domain/diff.ts`.
struct DiffRow: Equatable, Identifiable, Sendable {
    enum Kind: Equatable, Sendable { case hunk, context, add, delete }

    var kind: Kind
    var id: String
    var text: String
    var oldLine: Int?
    var newLine: Int?
}

enum Diff {
    /// The rows of one file's patch as `git diff` writes it, hunk headers included.
    static func rows(_ patch: String) -> [DiffRow] {
        var rows: [DiffRow] = []
        var hunkIndex = -1
        var oldLine = 0
        var newLine = 0
        var inHunk = false
        for line in patch.split(separator: "\n", omittingEmptySubsequences: false) {
            if line.hasPrefix("--- "), line != "--- /dev/null" { continue }
            if line.hasPrefix("+++ "), line != "+++ /dev/null" { continue }
            if let header = hunkHeader(line) {
                hunkIndex += 1
                inHunk = true
                oldLine = header.oldStart
                newLine = header.newStart
                let range = "@@ -\(header.oldStart),\(header.oldLines) +\(header.newStart),\(header.newLines) @@"
                rows.append(DiffRow(kind: .hunk, id: "h\(hunkIndex)", text: header.title.isEmpty ? range : "\(range) \(header.title)"))
                continue
            }
            guard inHunk, !line.isEmpty, !line.hasPrefix("\\") else { continue }
            let text = String(line.dropFirst())
            switch line.first {
            case "+":
                rows.append(DiffRow(kind: .add, id: "\(hunkIndex):n\(newLine)", text: text, oldLine: nil, newLine: newLine))
                newLine += 1
            case "-":
                rows.append(DiffRow(kind: .delete, id: "\(hunkIndex):o\(oldLine)", text: text, oldLine: oldLine, newLine: nil))
                oldLine += 1
            case " ":
                rows.append(DiffRow(kind: .context, id: "\(hunkIndex):c\(oldLine):\(newLine)", text: text, oldLine: oldLine, newLine: newLine))
                oldLine += 1
                newLine += 1
            default:
                break
            }
        }
        return rows
    }

    private struct HunkHeader {
        var oldStart: Int
        var oldLines: Int
        var newStart: Int
        var newLines: Int
        var title: String
    }

    private static let header = #/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/#

    private static func hunkHeader(_ line: Substring) -> HunkHeader? {
        guard let match = line.wholeMatch(of: header) else { return nil }
        return HunkHeader(oldStart: Int(match.1) ?? 0, oldLines: match.2.flatMap { Int($0) } ?? 1, newStart: Int(match.3) ?? 0, newLines: match.4.flatMap { Int($0) } ?? 1, title: match.5.trimmingCharacters(in: .whitespaces))
    }

    static func split(_ path: String) -> (folder: String, name: String) {
        guard let cut = path.lastIndex(of: "/") else { return ("", path) }
        return (String(path[...cut]), String(path[path.index(after: cut)...]))
    }
}
