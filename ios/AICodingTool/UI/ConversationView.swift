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
                VStack(alignment: .leading, spacing: 16) {
                    if thread.loading == true {
                        Text("Loading conversation…").font(.footnote).foregroundStyle(palette.muted).frame(maxWidth: .infinity)
                    }
                    if thread.omitted > 0 {
                        Label("\(thread.omitted) earlier \(thread.omitted == 1 ? "message" : "messages") on your computer", systemImage: "clock.arrow.circlepath")
                            .font(.footnote.weight(.medium))
                            .foregroundStyle(palette.muted)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 6)
                            .background(palette.sunken, in: Capsule())
                            .frame(maxWidth: .infinity)
                    }
                    let blocks = Format.transcriptBlocks(thread.messages)
                    let latest = Format.latestAnswer(blocks)
                    ForEach(blocks) { block in
                        switch block {
                        case .message(let key, let message, let answer): MessageView(message: message, answer: answer && key == latest)
                        case .tools(_, let calls): ToolRunView(engine: thread.settings.engine, calls: calls)
                        }
                    }
                    if let tail = thread.streamingTail {
                        MarkdownView(text: tail)
                    }
                    if thread.status == "running", thread.approval == nil, thread.question?.blocking != true {
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
                .padding(.top, 12)
                .padding(.bottom, 16)
            }
            .scrollDismissesKeyboard(.interactively)
            .hardTopEdge()
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

struct MessageView: View {
    var message: MobileMessage
    var answer: Bool
    @Environment(\.palette) private var palette
    @State private var copied = false

    var body: some View {
        switch message.kind {
        case "user":
            VStack(alignment: .trailing, spacing: 4) {
                if let origin = message.origin { Text(origin).font(.caption).foregroundStyle(palette.muted) }
                if let images = message.images, images > 0 {
                    Label("\(images) \(images == 1 ? "picture" : "pictures")", systemImage: "photo")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(palette.inkDim)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 5)
                        .background(palette.raised, in: Capsule())
                }
                if !message.text.isEmpty {
                    Text(message.text)
                        .foregroundStyle(palette.ink)
                        .lineSpacing(2)
                        .textSelection(.enabled)
                        .padding(.horizontal, 15)
                        .padding(.vertical, 10)
                        .background(palette.raised, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                }
            }
            .frame(maxWidth: .infinity, alignment: .trailing)
            .padding(.leading, 48)
            .padding(.top, 4)
        case "system":
            Text(message.text)
                .font(.footnote.weight(.medium))
                .foregroundStyle(palette.muted)
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(palette.sunken, in: Capsule())
                .frame(maxWidth: .infinity)
                .multilineTextAlignment(.center)
        default:
            VStack(alignment: .leading, spacing: 6) {
                MarkdownView(text: message.text)
                if answer {
                    HStack(spacing: 4) {
                        Text(Format.clockTime(message.at)).font(.caption).foregroundStyle(palette.quiet)
                        Button {
                            UIPasteboard.general.string = message.text
                            copied = true
                            Task { try? await Task.sleep(for: .seconds(1.5)); copied = false }
                        } label: {
                            Image(systemName: copied ? "checkmark" : "square.on.square")
                                .font(.caption.weight(.medium))
                                .foregroundStyle(copied ? palette.success : palette.quiet)
                                .frame(width: 28, height: 24)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(copied ? "Copied" : "Copy reply")
                    }
                }
            }
        }
    }
}

/// A run of tool calls. One call reads as what it did; several as a summary that opens to each call
/// and its argument, in the order they were made. A call's row opens to its whole argument.
struct ToolRunView: View {
    var engine: String
    var calls: [MobileMessage]
    @Environment(\.palette) private var palette
    @State private var open = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if calls.count == 1, let call = calls.first {
                ToolCallRow(engine: engine, call: call, leading: true)
            } else {
                Button {
                    withAnimation(.snappy) { open.toggle() }
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: ToolCallRow.family(engine, calls.first).symbol).font(.caption.weight(.medium)).foregroundStyle(palette.muted).frame(width: 18)
                        Text(Format.summariseTools(calls)).font(.footnote.weight(.medium)).foregroundStyle(palette.mutedStrong).lineLimit(1)
                        Spacer(minLength: 0)
                        Text("\(calls.count) steps").font(.caption.monospacedDigit()).foregroundStyle(palette.quiet)
                        Image(systemName: "chevron.down").font(.caption2.weight(.bold)).foregroundStyle(palette.quiet).rotationEffect(.degrees(open ? 180 : 0))
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityValue(open ? "Expanded" : "Collapsed")
                if open {
                    VStack(alignment: .leading, spacing: 10) {
                        ForEach(Array(calls.enumerated()), id: \.offset) { _, call in
                            ToolCallRow(engine: engine, call: call, leading: false)
                        }
                    }
                    .padding(.top, 4)
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .background(palette.sunken, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}

/// One tool call: its glyph and label over the argument that tells it apart, cut to two lines until opened.
private struct ToolCallRow: View {
    var engine: String
    var call: MobileMessage
    /// The only call in its run, which carries the run's own glyph and padding.
    var leading: Bool
    @Environment(\.palette) private var palette
    @State private var whole = false

    static func family(_ engine: String, _ call: MobileMessage?) -> ToolFamily {
        if let family = call?.call.flatMap({ ToolFamily(rawValue: $0.family) }) { return family }
        return ToolNames.family(engine: engine, call?.text ?? "")
    }

    var body: some View {
        let label = call.call?.label ?? ToolNames.label(call.text)
        let argument = call.call.map { $0.argument.isEmpty ? "" : ($0.sigil.map { "\($0) " } ?? "") + $0.argument } ?? ""
        Button {
            if !argument.isEmpty { withAnimation(.snappy) { whole.toggle() } }
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: Self.family(engine, call).symbol).font(.caption.weight(.medium)).foregroundStyle(palette.muted).frame(width: 18)
                VStack(alignment: .leading, spacing: 2) {
                    Text(label).font(.footnote.weight(.medium)).foregroundStyle(palette.mutedStrong)
                    if !argument.isEmpty {
                        Text(argument)
                            .font(.caption.monospaced())
                            .foregroundStyle(palette.muted)
                            .lineLimit(whole ? nil : 2)
                            .textSelection(.enabled)
                    }
                }
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
    }
}

private struct QueuedRow: View {
    var message: MobileQueuedMessage
    var onSteer: () -> Void
    var onDrop: () -> Void
    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Label(message.origin.map { "Queued · \($0)" } ?? "Queued", systemImage: "clock")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(palette.muted)
                Spacer(minLength: 0)
                if message.steering == true {
                    HStack(spacing: 6) {
                        ProgressView().controlSize(.mini)
                        Text("Steering…").font(.caption.weight(.medium))
                    }
                    .foregroundStyle(palette.muted)
                    .frame(height: 28)
                } else {
                    Button(action: onSteer) {
                        Label("Steer Now", systemImage: "bolt.fill")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(palette.accent)
                            .frame(height: 32)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint("Sends it into the running turn")
                    Button(action: onDrop) {
                        Image(systemName: "xmark")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(palette.quiet)
                            .frame(width: 32, height: 32)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Remove queued message")
                }
            }
            Text(message.text)
                .font(.subheadline)
                .foregroundStyle(palette.ink)
                .lineLimit(4)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.leading, 14)
        .padding(.trailing, 8)
        .padding(.top, 8)
        .padding(.bottom, 12)
        .background(palette.surface, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .padding(.leading, 40)
    }
}

struct ThinkingDots: View {
    @Environment(\.palette) private var palette

    var body: some View {
        TimelineView(.animation(minimumInterval: 0.15)) { context in
            let step = Int(context.date.timeIntervalSinceReferenceDate / 0.3) % 3
            HStack(spacing: 8) {
                HStack(spacing: 4) {
                    ForEach(0..<3, id: \.self) { index in
                        Circle().fill(palette.accent).frame(width: 6, height: 6).opacity(index == step ? 1 : 0.3)
                    }
                }
                Text("Working").font(.footnote.weight(.medium)).foregroundStyle(palette.muted)
            }
        }
        .padding(.vertical, 4)
    }
}
