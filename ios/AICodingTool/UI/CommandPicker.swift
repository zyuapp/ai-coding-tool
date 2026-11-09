import SwiftUI

/// The "/" menu over the composer: the thread's engine commands and skills that start with what follows
/// the "/", as the desktop's composer offers them. Tapping one puts it in the draft, ready for its arguments.
struct CommandPicker: View {
    /// Nil while the computer has yet to answer.
    var commands: [SlashCommand]?
    var query: String
    var onPick: (SlashCommand) -> Void

    @Environment(\.palette) private var palette
    private static let rowHeight: CGFloat = 58

    var body: some View {
        Group {
            if let commands {
                let matches = SlashCommands.matching(commands, query)
                if matches.isEmpty {
                    status("No matching commands")
                } else {
                    ScrollView {
                        LazyVStack(spacing: 0) {
                            ForEach(matches) { command in
                                row(command)
                                if command.id != matches.last?.id {
                                    Divider().overlay(palette.lineSoft).padding(.leading, 54)
                                }
                            }
                        }
                    }
                    .scrollBounceBehavior(.basedOnSize)
                    .frame(height: min(CGFloat(matches.count), 4.5) * Self.rowHeight)
                }
            } else {
                HStack(spacing: 10) {
                    Spinner(size: 15)
                    Text("Loading commands…")
                }
                .modifier(StatusRow(palette: palette))
            }
        }
        .background(palette.menu, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).strokeBorder(palette.lineSoft))
        .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
        .shadow(color: .black.opacity(palette.dark ? 0.35 : 0.08), radius: 14, y: 4)
        .padding(.horizontal, 12)
        .padding(.bottom, 6)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Commands")
    }

    private func row(_ command: SlashCommand) -> some View {
        Button { onPick(command) } label: {
            HStack(spacing: 12) {
                Image(systemName: "sparkles")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(palette.accent)
                    .frame(width: 30, height: 30)
                    .background(palette.accentChip, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 5) {
                        Text("/\(command.name)").foregroundStyle(palette.ink).fontWeight(.semibold).layoutPriority(1)
                        if !command.argumentHint.isEmpty { Text(command.argumentHint).foregroundStyle(palette.muted) }
                    }
                    .font(.body)
                    .lineLimit(1)
                    if !command.summary.isEmpty {
                        Text(command.summary)
                            .font(.footnote)
                            .foregroundStyle(palette.muted)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 12)
            .frame(height: Self.rowHeight)
            .contentShape(Rectangle())
        }
        .buttonStyle(.target)
        .accessibilityLabel([ "/\(command.name)", command.argumentHint, command.summary ].filter { !$0.isEmpty }.joined(separator: ", "))
        .accessibilityHint("Puts the command in your message")
    }

    private func status(_ text: String) -> some View {
        Text(text).modifier(StatusRow(palette: palette))
    }
}

private struct StatusRow: ViewModifier {
    var palette: Palette

    func body(content: Content) -> some View {
        content
            .font(.subheadline)
            .foregroundStyle(palette.muted)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 16)
            .frame(height: 48)
    }
}
