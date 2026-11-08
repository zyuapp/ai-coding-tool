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
    }
}

private struct BlockList: View {
    var blocks: [any Markup]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                BlockView(block: block)
            }
        }
    }
}

private struct BlockView: View {
    var block: any Markup
    @Environment(\.palette) private var palette

    var body: some View {
        switch block {
        case let heading as Heading:
            SwiftUI.Text(Inline.render(heading, palette: palette))
                .font(heading.level <= 1 ? .title3.weight(.semibold) : heading.level == 2 ? .headline : .subheadline.weight(.semibold))
                .foregroundStyle(palette.ink)
                .padding(.top, 4)
        case let paragraph as Paragraph:
            SwiftUI.Text(Inline.render(paragraph, palette: palette))
                .foregroundStyle(palette.ink)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        case let code as CodeBlock:
            CodeBlockView(code: code.code.hasSuffix("\n") ? String(code.code.dropLast()) : code.code)
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
                            SwiftUI.Image(systemName: checkbox == .checked ? "checkmark.square" : "square")
                        } else if let ordered {
                            SwiftUI.Text("\(ordered + index).").monospacedDigit()
                        } else {
                            SwiftUI.Text("•")
                        }
                    }
                    .foregroundStyle(palette.muted)
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
        let head = Array(table.head.cells)
        let rows = table.body.rows.map { Array($0.cells) }
        ScrollView(.horizontal, showsIndicators: false) {
            Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 8) {
                GridRow {
                    ForEach(Array(head.enumerated()), id: \.offset) { _, cell in
                        SwiftUI.Text(Inline.render(cell, palette: palette)).font(.subheadline.weight(.semibold)).foregroundStyle(palette.ink)
                    }
                }
                Divider().overlay(palette.line)
                ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                    GridRow {
                        ForEach(Array(row.enumerated()), id: \.offset) { _, cell in
                            SwiftUI.Text(Inline.render(cell, palette: palette)).font(.subheadline).foregroundStyle(palette.inkDim)
                        }
                    }
                }
            }
            .padding(10)
        }
        .background(palette.sunken, in: RoundedRectangle(cornerRadius: 10))
    }
}

struct CodeBlockView: View {
    var code: String
    @Environment(\.palette) private var palette
    @State private var copied = false

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            SwiftUI.Text(code)
                .font(.footnote.monospaced())
                .foregroundStyle(palette.codeInk)
                .textSelection(.enabled)
                .padding(12)
                .padding(.trailing, 28)
        }
        .background(palette.codeSurface, in: RoundedRectangle(cornerRadius: 10))
        .overlay(alignment: .topTrailing) {
            Button {
                UIPasteboard.general.string = code
                copied = true
                Task { try? await Task.sleep(for: .seconds(1.5)); copied = false }
            } label: {
                SwiftUI.Image(systemName: copied ? "checkmark" : "doc.on.doc").font(.caption).foregroundStyle(palette.muted).frame(width: 32, height: 32)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(copied ? "Copied" : "Copy code")
        }
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
            inner.font = .system(.callout, design: .monospaced)
            inner.backgroundColor = palette.codeSurface
            return inner
        case let link as Markdown.Link:
            var inner = render(link, palette: palette)
            if let destination = link.destination, let url = URL(string: destination), let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" {
                inner.link = url
                inner.foregroundColor = palette.link
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
