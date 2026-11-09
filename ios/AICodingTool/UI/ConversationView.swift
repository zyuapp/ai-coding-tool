import SwiftUI

/// The transcript, pinned to its end. A reader already scrolled up is left where they are, so a
/// reply arriving mid-scroll does not snatch the page away.
struct ConversationView: View {
    var thread: MobileThreadView
    var model: PhoneModel
    @Environment(\.palette) private var palette
    @State private var pinned = true
    @State private var atEnd = true
    /// The top message when older messages were asked for, held in place once they land above it. A
    /// tool run is never held: older calls landing above it join it under another key.
    @State private var heldTop: (key: String, omitted: Int)?

    private var anchor: String {
        "\(thread.id):\(thread.messages.count):\(thread.messages.last?.at ?? 0):\(thread.streamingTail?.utf16.count ?? -1):\(thread.queued.count):\(thread.status)"
    }

    var body: some View {
        let transcript = model.transcript(thread)
        let blocks = Format.transcriptBlocks(transcript.messages, omitted: transcript.omitted)
        let latest = Format.latestAnswer(blocks)
        ScrollViewReader { reader in
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    if thread.loading == true {
                        HStack(spacing: Space.s) {
                            Spinner(size: 12, color: palette.muted)
                            Text("Loading conversation").font(.footnote).foregroundStyle(palette.muted)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.top, Space.xl)
                    }
                    if transcript.omitted > 0 {
                        EarlierButton(count: transcript.omitted, reading: model.readingEarlier == thread.id,
                                      failure: model.earlierFailed?.taskId == thread.id ? model.earlierFailed?.message : nil) {
                            heldTop = blocks.first(where: \.isMessage).map { ($0.id, transcript.omitted) }
                            model.readEarlier(thread.id)
                        }
                    }
                    ForEach(blocks) { block in
                        switch block {
                        case .message(let key, let message, let answer):
                            MessageView(message: message, answer: answer && key == latest, changes: thread.reviewable ? thread.changes : nil, onChanges: { model.enterChanges() })
                                .transition(message.kind == "user" ? .rise : .identity)
                        case .tools(_, let calls):
                            ToolRunView(engine: thread.settings.engine, calls: calls).transition(.opacity)
                        }
                    }
                    if let tail = thread.streamingTail {
                        MarkdownView(text: tail).transition(.identity)
                    }
                    if thread.status == "running", thread.approval == nil, thread.question?.blocking != true {
                        WorkingLine().transition(.asymmetric(insertion: .opacity, removal: .identity))
                    }
                    if !thread.queued.isEmpty {
                        VStack(spacing: Space.s) {
                            ForEach(thread.queued) { message in
                                QueuedRow(message: message, editing: model.editing?.messageId == message.id, busy: model.editing != nil,
                                          onEdit: message.editable == true ? { model.editQueued(thread.id, message) } : nil,
                                          onSteer: { model.send(.steerQueued(thread.id, messageId: message.id)) },
                                          onDrop: { model.send(.dropQueued(thread.id, messageId: message.id)) })
                                    .transition(.rise)
                            }
                        }
                        .accessibilityElement(children: .contain)
                        .accessibilityLabel("Queued messages")
                    }
                    Color.clear.frame(height: 1).id("end")
                }
                .padding(.horizontal, Space.page)
                .padding(.top, Space.m)
                .padding(.bottom, Space.l)
                .overlay(alignment: .bottom) {
                    Color.clear
                        .frame(height: 64)
                        .onScrollVisibilityChange(threshold: 0.2) { atEnd = $0 }
                        .allowsHitTesting(false)
                }
                // Older messages land above the reader without moving or animating what they were reading.
                .transaction(value: model.state.earlier?.start) { $0.animation = nil }
                .animation(.glide, value: blocks.count)
                .animation(.glide, value: thread.queued.count)
                .animation(.glide, value: thread.status)
            }
            .scrollDismissesKeyboard(.interactively)
            .environment(\.pictureSource, PictureSource(taskId: thread.id, store: model.pictures, connection: model.connection))
            .hardTopEdge()
            .defaultScrollAnchor(.top, for: .alignment)
            .defaultScrollAnchor(.bottom, for: .initialOffset)
            .defaultScrollAnchor(.bottom, for: .sizeChanges)
            // A card rising over the composer shortens the page, and a reader at the end stays there.
            .onScrollGeometryChange(for: CGFloat.self) { $0.contentInsets.bottom } action: { _, _ in
                if pinned { reader.scrollTo("end", anchor: .bottom) }
            }
            // Only the reader's own scrolling decides whether the end is followed; content growing under them does not.
            .onScrollPhaseChange { _, phase in
                if phase == .interacting { pinned = false }
                if phase == .idle { pinned = atEnd }
            }
            .onChange(of: anchor) { _, _ in
                if pinned { reader.scrollTo("end", anchor: .bottom) }
            }
            .onChange(of: transcript.omitted) { _, omitted in
                guard let heldTop, omitted < heldTop.omitted else { return }
                self.heldTop = nil
                reader.scrollTo(heldTop.key, anchor: .top)
            }
            .onChange(of: thread.id) { _, _ in
                pinned = true
                reader.scrollTo("end", anchor: .bottom)
            }
            .onAppear {
                pinned = true
                Task { @MainActor in reader.scrollTo("end", anchor: .bottom) }
            }
            .overlay(alignment: .bottom) {
                if !atEnd {
                    Button {
                        pinned = true
                        withAnimation(.glide) { reader.scrollTo("end", anchor: .bottom) }
                    } label: {
                        Image(systemName: "arrow.down")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(palette.ink)
                            .frame(width: 44, height: 44)
                            .floatingSurface(palette, in: Circle())
                    }
                    .buttonStyle(.target)
                    .padding(.bottom, Space.s)
                    .transition(.pop)
                    .accessibilityLabel("Jump to latest")
                }
            }
            .animation(.touch, value: atEnd)
        }
    }
}

/// How many messages sit above the transcript on the computer; a tap reads the next page of them.
private struct EarlierButton: View {
    var count: Int
    var reading: Bool
    var failure: String?
    var action: () -> Void
    @Environment(\.palette) private var palette

    var body: some View {
        VStack(spacing: Space.xs) {
            Button(action: action) {
                HStack(spacing: 6) {
                    if reading {
                        Spinner(size: 11, color: palette.muted)
                    } else {
                        Image(systemName: "arrow.up").font(.caption2.weight(.bold))
                    }
                    Text("\(count) earlier \(count == 1 ? "message" : "messages")")
                }
                .font(.caption.weight(.medium))
                .foregroundStyle(palette.inkDim)
                .padding(.horizontal, 12)
                .padding(.vertical, 7)
                .background(palette.raised, in: Capsule())
            }
            .buttonStyle(.target)
            .disabled(reading)
            .accessibilityLabel("Show earlier messages")
            .accessibilityValue("\(count) on your computer")
            if let failure {
                Text(failure).font(.caption).foregroundStyle(palette.danger).multilineTextAlignment(.center)
            }
        }
        .frame(maxWidth: .infinity)
    }
}

struct MessageView: View {
    var message: MobileMessage
    var answer: Bool
    /// What the thread has changed on disk, shown under its latest answer.
    var changes: MobileChanges? = nil
    var onChanges: (() -> Void)? = nil
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
                        .background(palette.raised, in: RoundedRectangle(cornerRadius: Radius.bubble, style: .continuous))
                }
            }
            .frame(maxWidth: .infinity, alignment: .trailing)
            .padding(.leading, 56)
            .padding(.top, 6)
        case "system":
            Text(message.text)
                .font(.caption.weight(.medium))
                .foregroundStyle(palette.muted)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)
                .padding(.horizontal, Space.xl)
        default:
            VStack(alignment: .leading, spacing: 6) {
                MarkdownView(text: message.text)
                if let id = message.id { MessagePicturesView(messageId: id, text: message.text) }
                if answer {
                    HStack(spacing: 0) {
                        Text(Format.clockTime(message.at)).font(.caption.monospacedDigit()).foregroundStyle(palette.quiet)
                        Button {
                            UIPasteboard.general.string = message.text
                            copied = true
                            Task { try? await Task.sleep(for: .seconds(1.5)); copied = false }
                        } label: {
                            Image(systemName: copied ? "checkmark" : "square.on.square")
                                .font(.caption.weight(.medium))
                                .foregroundStyle(copied ? palette.success : palette.quiet)
                                .contentTransition(.symbolEffect(.replace))
                                .frame(width: 44, height: 44)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.target)
                        .accessibilityLabel(copied ? "Copied" : "Copy reply")
                        Spacer(minLength: Space.s)
                        if let changes, changes.files > 0, let onChanges {
                            ChangesChip(changes: changes, action: onChanges).transition(.pop)
                        }
                    }
                    .padding(.top, -Space.s)
                    .sensoryFeedback(.success, trigger: copied) { _, next in next }
                }
            }
        }
    }
}

/// What the thread has changed on disk, which opens the comparison.
private struct ChangesChip: View {
    var changes: MobileChanges
    var action: () -> Void
    @Environment(\.palette) private var palette

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Text("\(changes.files) \(changes.files == 1 ? "file" : "files")").foregroundStyle(palette.inkDim)
                Counts(additions: changes.additions, deletions: changes.deletions)
                Image(systemName: "chevron.right").font(.caption2.weight(.bold)).foregroundStyle(palette.quiet)
            }
            .font(.footnote.weight(.medium).monospacedDigit())
            .padding(.horizontal, Space.m)
            .frame(height: 32)
            .background(palette.surface, in: Capsule())
            .overlay(Capsule().strokeBorder(palette.line))
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.press)
        .accessibilityLabel("Changes, \(Format.changesLabel(changes) ?? "")")
        .accessibilityHint("Opens what this thread changed")
    }
}

/// A run of tool calls. One call reads as what it did; several as a summary that opens to each call
/// and its argument, in the order they were made. A call's row opens to its whole argument.
struct ToolRunView: View {
    var engine: String
    var calls: [MobileMessage]
    @Environment(\.palette) private var palette
    @State private var open = false

    /// A call of the tool the summary names first, whose glyph stands for the run.
    private var commonest: MobileMessage? {
        let labels = calls.map { $0.call?.label ?? ToolNames.label($0.text) }
        let places = Dictionary(grouping: labels.indices, by: { labels[$0] }).values
        let lead = places.max { left, right in left.count != right.count ? left.count < right.count : left[0] > right[0] }
        return lead.map { calls[$0[0]] }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if calls.count == 1, let call = calls.first {
                ToolCallRow(engine: engine, call: call, leading: true)
            } else {
                Button {
                    withAnimation(.glide) { open.toggle() }
                } label: {
                    HStack(spacing: Space.s) {
                        Image(systemName: ToolCallRow.family(engine, commonest).symbol).font(.caption.weight(.medium)).foregroundStyle(palette.muted).frame(width: 18)
                        Text(Format.summariseTools(calls)).font(.footnote.weight(.medium)).foregroundStyle(palette.mutedStrong).lineLimit(1)
                        Spacer(minLength: 0)
                        Text("\(calls.count)").font(.caption.weight(.medium).monospacedDigit()).foregroundStyle(palette.muted).contentTransition(.numericText())
                        Image(systemName: "chevron.down").font(.caption2.weight(.bold)).foregroundStyle(palette.quiet).rotationEffect(.degrees(open ? 180 : 0))
                    }
                    .contentShape(Rectangle())
                }
                .accessibilityLabel("\(Format.summariseTools(calls)), \(calls.count) steps")
                .buttonStyle(.target)
                .accessibilityValue(open ? "Expanded" : "Collapsed")
                if open {
                    VStack(alignment: .leading, spacing: 10) {
                        ForEach(Array(calls.enumerated()), id: \.offset) { _, call in
                            ToolCallRow(engine: engine, call: call, leading: false)
                        }
                    }
                    .padding(.top, Space.xs)
                    .transition(.opacity)
                }
            }
        }
        .padding(.horizontal, Space.m)
        .padding(.vertical, 10)
        .background(palette.sunken, in: RoundedRectangle(cornerRadius: Radius.block, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Radius.block, style: .continuous).strokeBorder(palette.lineSoft))
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
            if !argument.isEmpty { withAnimation(.glide) { whole.toggle() } }
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: Self.family(engine, call).symbol).font(.caption.weight(.medium)).foregroundStyle(palette.muted).frame(width: 18)
                VStack(alignment: .leading, spacing: 2) {
                    Text(label).font(.footnote.weight(.medium)).foregroundStyle(palette.mutedStrong)
                    if !argument.isEmpty {
                        Text(argument)
                            .font(.caption.monospaced())
                            .foregroundStyle(palette.muted)
                            .lineLimit(whole ? nil : 1)
                            .textSelection(.enabled)
                    }
                }
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.target)
        .accessibilityElement(children: .combine)
    }
}

private struct QueuedRow: View {
    var message: MobileQueuedMessage
    /// This message is on its way back to the composer.
    var editing: Bool
    /// Some message is on its way back, so no other edit starts.
    var busy: Bool
    /// Nil for a message only the computer can edit.
    var onEdit: (() -> Void)?
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
                if message.steering == true || editing {
                    HStack(spacing: 6) {
                        Spinner(size: 11, color: palette.muted)
                        Text(editing ? "Editing…" : "Steering…").font(.caption.weight(.medium))
                    }
                    .foregroundStyle(palette.muted)
                    .frame(height: 28)
                } else {
                    if let onEdit {
                        Button(action: onEdit) {
                            Image(systemName: "pencil")
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(palette.inkDim)
                                .frame(width: 44, height: 44)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.target)
                        .disabled(busy)
                        .accessibilityLabel("Edit queued message")
                        .accessibilityHint("Takes it out of the queue and into the message field")
                    }
                    Button(action: onSteer) {
                        Label("Steer Now", systemImage: "bolt.fill")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(palette.accent)
                            .frame(height: 44)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.target)
                    .accessibilityHint("Sends it into the running turn")
                    Button(action: onDrop) {
                        Image(systemName: "xmark")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(palette.quiet)
                            .frame(width: 44, height: 44)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.target)
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
        .background(palette.surface, in: RoundedRectangle(cornerRadius: Radius.bubble, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Radius.bubble, style: .continuous).strokeBorder(palette.lineSoft))
        .padding(.leading, 56)
    }
}

/// The line under a transcript while its thread works.
struct WorkingLine: View {
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: Space.s) {
            Spinner(size: 13, color: palette.accent)
            Text("Working")
                .font(.subheadline.weight(.medium))
                .foregroundStyle(palette.muted)
                .shimmer(palette.ink)
        }
        .padding(.vertical, Space.xs)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Working")
    }
}
