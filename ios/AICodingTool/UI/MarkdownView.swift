import Markdown
import SwiftUI

/// A reply's markdown, GitHub-flavoured. Only web links are tappable, since a phone can act on
/// neither a file path nor a thread link; a code block carries a copy button.
struct MarkdownView: View {
    var text: String

    var body: some View {
        let document = Document(parsing: text, options: [.disableSmartOpts])
        BlockList(blocks: document.blockChildren.map { $0 as any Markup })
            .frame(maxWidth: .infinity, alignment: .leading)
            .environment(\.openFenceLine, Self.openFenceLine(text))
    }

    /// The line, counted from 1, that opens a code fence the text has not closed yet.
    static func openFenceLine(_ text: String) -> Int? {
        var open: (run: Substring, line: Int)?
        for (index, line) in text.split(separator: "\n", omittingEmptySubsequences: false).enumerated() {
            let trimmed = line.drop { $0 == " " }
            guard let mark = trimmed.first, mark == "`" || mark == "~" else { continue }
            let run = trimmed.prefix { $0 == mark }
            guard run.count >= 3 else { continue }
            if let fence = open?.run {
                if fence.first == mark, run.count >= fence.count, trimmed.dropFirst(run.count).allSatisfy(\.isWhitespace) { open = nil }
            } else if mark == "~" || !trimmed.dropFirst(run.count).contains("`") {
                open = (run, index + 1)
            }
        }
        return open?.line
    }
}

private struct OpenFenceLineKey: EnvironmentKey {
    static let defaultValue: Int? = nil
}

private extension EnvironmentValues {
    var openFenceLine: Int? {
        get { self[OpenFenceLineKey.self] }
        set { self[OpenFenceLineKey.self] = newValue }
    }
}

private struct BlockList: View {
    var blocks: [any Markup]

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                BlockView(block: block)
            }
        }
    }
}

private struct BlockView: View {
    var block: any Markup
    @Environment(\.palette) private var palette
    @Environment(\.openFenceLine) private var openFenceLine

    var body: some View {
        switch block {
        case let heading as Heading:
            SwiftUI.Text(Inline.render(heading, palette: palette))
                .font(heading.level <= 1 ? .title2.weight(.bold) : heading.level == 2 ? .title3.weight(.semibold) : .headline)
                .foregroundStyle(palette.ink)
                .padding(.top, 6)
        case let paragraph as Paragraph:
            SwiftUI.Text(Inline.render(paragraph, palette: palette))
                .foregroundStyle(palette.ink)
                .lineSpacing(3)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        case let code as CodeBlock where code.language?.lowercased() == "mermaid":
            let source = code.code.hasSuffix("\n") ? String(code.code.dropLast()) : code.code
            MermaidBlockView(source: source, pending: openFenceLine != nil && code.range?.lowerBound.line == openFenceLine)
        case let code as CodeBlock:
            CodeBlockView(code: code.code.hasSuffix("\n") ? String(code.code.dropLast()) : code.code, language: code.language)
        case let quote as BlockQuote:
            BlockList(blocks: quote.blockChildren.map { $0 as any Markup })
                .padding(.leading, 12)
                .overlay(alignment: .leading) { palette.lineStrong.frame(width: 3) }
                .foregroundStyle(palette.inkDim)
        case let list as UnorderedList:
            ListView(items: Array(list.listItems), ordered: nil)
        case let list as OrderedList:
            ListView(items: Array(list.listItems), ordered: Int(list.startIndex))
        case let table as Markdown.Table:
            TableView(table: table)
        case is ThematicBreak:
            palette.line.frame(height: 1).padding(.vertical, 4)
        case let html as HTMLBlock:
            SwiftUI.Text(html.rawHTML).font(.footnote.monospaced()).foregroundStyle(palette.muted)
        default:
            SwiftUI.Text(block.format()).foregroundStyle(palette.ink)
        }
    }
}

private struct ListView: View {
    var items: [ListItem]
    /// The first number of an ordered list, or nil for bullets.
    var ordered: Int?
    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Group {
                        if let checkbox = item.checkbox {
                            SwiftUI.Image(systemName: checkbox == .checked ? "checkmark.circle.fill" : "circle")
                                .foregroundStyle(checkbox == .checked ? palette.success : palette.quiet)
                        } else if let ordered {
                            SwiftUI.Text("\(ordered + index).").monospacedDigit().foregroundStyle(palette.muted)
                        } else {
                            SwiftUI.Text("•").foregroundStyle(palette.muted)
                        }
                    }
                    .frame(minWidth: 16, alignment: .leading)
                    BlockList(blocks: item.blockChildren.map { $0 as any Markup })
                }
            }
        }
    }
}

private struct TableView: View {
    var table: Markdown.Table
    @Environment(\.palette) private var palette

    var body: some View {
        ViewThatFits(in: .horizontal) {
            grid(fill: true)
            ScrollView(.horizontal, showsIndicators: false) { grid(fill: false) }
        }
        .background(palette.sunken, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(palette.lineSoft))
    }

    /// A filled grid shares the card's width among its columns; a scrolling one keeps every column to its content.
    private func grid(fill: Bool) -> some View {
        let head = Array(table.head.cells)
        let rows = table.body.rows.map { Array($0.cells) }
        return Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 0) {
            GridRow {
                ForEach(Array(head.enumerated()), id: \.offset) { _, cell in
                    SwiftUI.Text(Inline.render(cell, palette: palette))
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(palette.muted)
                        .frame(maxWidth: fill ? .infinity : nil, alignment: .leading)
                        .padding(.vertical, 9)
                }
            }
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                palette.lineSoft.frame(height: 1).gridCellUnsizedAxes(.horizontal)
                GridRow {
                    ForEach(Array(row.enumerated()), id: \.offset) { _, cell in
                        SwiftUI.Text(Inline.render(cell, palette: palette))
                            .font(.subheadline)
                            .foregroundStyle(palette.ink)
                            .frame(maxWidth: fill ? .infinity : nil, alignment: .leading)
                            .padding(.vertical, 9)
                    }
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 2)
        .fixedSize(horizontal: !fill, vertical: false)
    }
}

struct CodeBlockView: View {
    var code: String
    var language: String? = nil
    @Environment(\.palette) private var palette
    @AppStorage(WrapLines.key) private var wrap = true
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 14) {
                SwiftUI.Text(language.flatMap { $0.isEmpty ? nil : $0 } ?? "code")
                    .font(.caption.weight(.semibold).monospaced())
                    .foregroundStyle(palette.muted)
                Spacer(minLength: 0)
                WrapLinesButton(wrap: $wrap)
                Button {
                    UIPasteboard.general.string = code
                    copied = true
                    Task { try? await Task.sleep(for: .seconds(1.5)); copied = false }
                } label: {
                    Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "square.on.square")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(copied ? palette.success : palette.muted)
                        .frame(height: 32)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(copied ? "Copied" : "Copy code")
            }
            .padding(.horizontal, 14)
            palette.lineSoft.frame(height: 1)
            if wrap {
                WrappedCode(text: code, color: UIColor(palette.codeInk), selectable: true)
                    .padding(14)
            } else {
                ScrollView(.horizontal) {
                    text.padding(.trailing, 42)
                }
            }
        }
        .background(palette.codeSurface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(palette.lineSoft))
    }

    private var text: some View {
        SwiftUI.Text(code)
            .font(.footnote.monospaced())
            .lineSpacing(2)
            .foregroundStyle(palette.codeInk)
            .textSelection(.enabled)
            .padding(14)
    }
}

/// Whether code and diffs wrap long lines, one choice for the whole app.
enum WrapLines {
    static let key = "wrapLines"
}

/// Switches code between wrapping long lines and scrolling sideways.
struct WrapLinesButton: View {
    @Binding var wrap: Bool
    @Environment(\.palette) private var palette

    var body: some View {
        Button { withAnimation(.snappy) { wrap.toggle() } } label: {
            SwiftUI.Image(systemName: "arrow.turn.down.left")
                .font(.caption.weight(.semibold))
                .foregroundStyle(wrap ? palette.accent : palette.muted)
                .frame(width: 28, height: 32)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Wrap lines")
        .accessibilityValue(wrap ? "On" : "Off")
    }
}

/// A block's inline children as one attributed string.
enum Inline {
    static func render(_ markup: any Markup, palette: Palette) -> AttributedString {
        var result = AttributedString()
        for child in markup.children { result += inline(child, palette: palette) }
        return result
    }

    private static func inline(_ markup: any Markup, palette: Palette) -> AttributedString {
        switch markup {
        case let text as Markdown.Text:
            return AttributedString(text.string)
        case let emphasis as Emphasis:
            var inner = render(emphasis, palette: palette)
            inner.inlinePresentationIntent = (inner.inlinePresentationIntent ?? []).union(.emphasized)
            return inner
        case let strong as Strong:
            var inner = render(strong, palette: palette)
            inner.inlinePresentationIntent = (inner.inlinePresentationIntent ?? []).union(.stronglyEmphasized)
            return inner
        case let strike as Strikethrough:
            var inner = render(strike, palette: palette)
            inner.strikethroughStyle = .single
            return inner
        case let code as InlineCode:
            var inner = AttributedString(code.code)
            inner.font = .system(.subheadline, design: .monospaced)
            inner.backgroundColor = palette.codeSurface
            return inner
        case let link as Markdown.Link:
            var inner = render(link, palette: palette)
            if let destination = link.destination, let url = URL(string: destination), let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" {
                inner.link = url
                inner.foregroundColor = palette.accent
                inner.underlineStyle = .single
            }
            return inner
        case let image as Markdown.Image:
            return AttributedString(image.plainText)
        case is SoftBreak:
            return AttributedString(" ")
        case is LineBreak:
            return AttributedString("\n")
        case let html as InlineHTML:
            return AttributedString(html.rawHTML)
        default:
            return render(markup, palette: palette)
        }
    }
}

/// Code wrapped the way an editor wraps it: a wrapped line continues under its own indent plus two columns, so structure survives on a narrow screen.
struct WrappedCode: UIViewRepresentable {
    var text: String
    var color: UIColor
    var selectable: Bool

    static var font: UIFont {
        UIFont.monospacedSystemFont(ofSize: UIFont.preferredFont(forTextStyle: .footnote).pointSize, weight: .regular)
    }

    static func styled(_ text: String, font: UIFont, color: UIColor) -> NSAttributedString {
        let column = ("0" as NSString).size(withAttributes: [.font: font]).width
        let result = NSMutableAttributedString()
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
        for (index, line) in lines.enumerated() {
            let indent = line.prefix { $0 == " " || $0 == "\t" }.reduce(0) { $0 + ($1 == "\t" ? 4 : 1) }
            let style = NSMutableParagraphStyle()
            style.headIndent = CGFloat(indent + 2) * column
            style.lineSpacing = 2
            style.lineBreakMode = .byWordWrapping
            let piece = String(line) + (index < lines.count - 1 ? "\n" : "")
            result.append(NSAttributedString(string: piece, attributes: [.font: font, .foregroundColor: color, .paragraphStyle: style]))
        }
        return result
    }

    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.isEditable = false
        view.isScrollEnabled = false
        view.backgroundColor = .clear
        view.textContainerInset = .zero
        view.textContainer.lineFragmentPadding = 0
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return view
    }

    func updateUIView(_ view: UITextView, context: Context) {
        view.isSelectable = selectable
        view.attributedText = Self.styled(text, font: Self.font, color: color)
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: UITextView, context: Context) -> CGSize? {
        let width = proposal.width ?? 320
        let fitted = uiView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
        return CGSize(width: width, height: ceil(fitted.height))
    }
}
