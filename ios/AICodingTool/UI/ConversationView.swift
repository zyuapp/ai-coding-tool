import SwiftUI

/// The transcript, pinned to its end. A reader already scrolled up is left where they are, so a
/// reply arriving mid-scroll does not snatch the page away.
struct ConversationView: View {
    var thread: MobileThreadView
    var model: PhoneModel
    @Environment(\.palette) private var palette
    @State private var pinned = true
    @State private var atEnd = true

    private var anchor: String {
        "\(thread.id):\(thread.messages.count):\(thread.messages.last?.at ?? 0):\(thread.streamingTail?.utf16.count ?? -1):\(thread.queued.count):\(thread.status)"
    }

    var body: some View {
        ScrollViewReader { reader in
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if thread.loading == true {
                        Text("Loading conversation…").font(.footnote).foregroundStyle(palette.muted).frame(maxWidth: .infinity)
                    }
                    if thread.omitted > 0 {
                        Label("\(thread.omitted) earlier \(thread.omitted == 1 ? "message" : "messages") are only on the computer.", systemImage: "clock.arrow.circlepath")
                            .font(.footnote)
                            .foregroundStyle(palette.muted)
                            .frame(maxWidth: .infinity)
                    }
                    ForEach(Format.transcriptBlocks(thread.messages)) { block in
                        switch block {
                        case .message(_, let message, let answer): MessageView(message: message, answer: answer)
                        case .tools(_, let calls): ToolRunView(engine: thread.settings.engine, calls: calls)
                        }
                    }
                    if let tail = thread.streamingTail {
                        MarkdownView(text: tail)
                    }
                    if thread.status == "running", thread.streamingTail == nil {
                        ThinkingDots().accessibilityLabel("Working")
                    }
                    if !thread.queued.isEmpty {
                        VStack(spacing: 8) {
                            ForEach(thread.queued) { message in
                                QueuedRow(message: message, onSteer: { model.send(.steerQueued(thread.id, messageId: message.id)) }, onDrop: {
                                    model.send(.dropQueued(thread.id, messageId: message.id))
                                    model.handBack(message.text)
                                })
                            }
                        }
                        .accessibilityElement(children: .contain)
                        .accessibilityLabel("Queued messages")
                    }
                    Color.clear.frame(height: 1).id("end")
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
            }
            .scrollDismissesKeyboard(.interactively)
            .defaultScrollAnchor(.bottom)
            .onScrollGeometryChange(for: Bool.self) { geometry in
                geometry.contentSize.height - geometry.contentOffset.y - geometry.containerSize.height + geometry.contentInsets.bottom < 48
            } action: { _, next in
                atEnd = next
            }
            // Only the reader's own scrolling decides whether the end is followed; content growing under them does not.
            .onScrollPhaseChange { _, phase in
                if phase == .interacting { pinned = false }
                if phase == .idle { pinned = atEnd }
            }
            .onChange(of: anchor) { _, _ in
                if pinned { reader.scrollTo("end", anchor: .bottom) }
            }
            .onChange(of: thread.id) { _, _ in
                pinned = true
                reader.scrollTo("end", anchor: .bottom)
            }
            .onAppear {
                pinned = true
                Task { @MainActor in reader.scrollTo("end", anchor: .bottom) }
            }
        }
    }
}

private struct MessageView: View {
    var message: MobileMessage
    var answer: Bool
    @Environment(\.palette) private var palette
    @State private var copied = false

    var body: some View {
        switch message.kind {
        case "user":
            VStack(alignment: .trailing, spacing: 4) {
                if let origin = message.origin { Text(origin).font(.caption).foregroundStyle(palette.muted) }
                Text(message.text)
                    .foregroundStyle(palette.ink)
                    .textSelection(.enabled)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(palette.raised, in: RoundedRectangle(cornerRadius: 18))
            }
            .frame(maxWidth: .infinity, alignment: .trailing)
            .padding(.leading, 40)
        case "system":
            Text(message.text)
                .font(.footnote)
                .foregroundStyle(palette.muted)
                .frame(maxWidth: .infinity)
                .multilineTextAlignment(.center)
        default:
            VStack(alignment: .leading, spacing: 6) {
                MarkdownView(text: message.text)
                if answer {
                    HStack(spacing: 12) {
                        Text(Format.clockTime(message.at)).font(.caption).foregroundStyle(palette.quiet)
                        Button {
                            UIPasteboard.general.string = message.text
                            copied = true
                            Task { try? await Task.sleep(for: .seconds(1.5)); copied = false }
                        } label: {
                            Image(systemName: copied ? "checkmark" : "doc.on.doc").font(.caption).foregroundStyle(palette.muted)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(copied ? "Copied" : "Copy reply")
                    }
                }
            }
        }
    }
}

/// A run of more than one call is a card that opens to every call in order; a lone call is a plain line.
private struct ToolRunView: View {
    var engine: String
    var calls: [MobileMessage]
    @Environment(\.palette) private var palette
    @State private var open = false

    var body: some View {
        let family = ToolNames.family(engine: engine, calls.first?.text ?? "")
        VStack(alignment: .leading, spacing: 6) {
            Button {
                if calls.count > 1 { withAnimation(.snappy) { open.toggle() } }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: family.symbol).font(.caption).foregroundStyle(palette.muted).frame(width: 18)
                    Text(Format.summariseTools(calls)).font(.footnote).foregroundStyle(palette.mutedStrong).lineLimit(1)
                    Spacer(minLength: 0)
                    if calls.count > 1 {
                        Text("\(calls.count)").font(.caption.monospacedDigit()).foregroundStyle(palette.muted)
                        Image(systemName: "chevron.down").font(.caption2.weight(.bold)).foregroundStyle(palette.quiet).rotationEffect(.degrees(open ? 180 : 0))
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(calls.count < 2)
            .accessibilityValue(calls.count > 1 ? (open ? "Expanded" : "Collapsed") : "")
            if open {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(Array(calls.enumerated()), id: \.offset) { index, call in
                        Text("\(index + 1). \(ToolNames.label(call.text))").font(.caption).foregroundStyle(palette.muted)
                    }
                }
                .padding(.leading, 26)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(palette.sunken, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(palette.lineSoft))
    }
}

private struct QueuedRow: View {
    var message: MobileQueuedMessage
    var onSteer: () -> Void
    var onDrop: () -> Void
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "arrow.turn.down.right").font(.caption).foregroundStyle(palette.muted).padding(.top, 3)
            VStack(alignment: .leading, spacing: 2) {
                if let origin = message.origin { Text(origin).font(.caption).foregroundStyle(palette.muted) }
                Text(message.text).font(.subheadline).foregroundStyle(palette.inkDim).lineLimit(4)
            }
            Spacer(minLength: 4)
            if message.steering == true {
                HStack(spacing: 4) {
                    ProgressView().controlSize(.mini)
                    Text("Steering…").font(.caption)
                }
                .foregroundStyle(palette.muted)
            } else {
                Button(action: onSteer) {
                    Label("Steer", systemImage: "bolt").font(.caption.weight(.semibold))
                }
                .buttonStyle(.bordered)
                .buttonBorderShape(.capsule)
                .controlSize(.small)
                Button(action: onDrop) {
                    Image(systemName: "xmark").font(.caption.weight(.bold)).foregroundStyle(palette.muted).frame(width: 28, height: 28)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Remove queued message")
            }
        }
        .padding(10)
        .background(palette.surface, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(palette.line, style: StrokeStyle(lineWidth: 1, dash: [4, 3])))
    }
}

private struct ThinkingDots: View {
    @Environment(\.palette) private var palette

    var body: some View {
        TimelineView(.animation(minimumInterval: 0.15)) { context in
            let step = Int(context.date.timeIntervalSinceReferenceDate / 0.3) % 3
            HStack(spacing: 5) {
                ForEach(0..<3, id: \.self) { index in
                    Circle().fill(palette.muted).frame(width: 6, height: 6).opacity(index == step ? 1 : 0.35)
                }
            }
        }
        .padding(.vertical, 4)
    }
}
