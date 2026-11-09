import SwiftUI

/// The frame every card over the composer wears: raised off the transcript, edged in the accent.
struct CardFrame: ViewModifier {
    @Environment(\.palette) private var palette

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: Radius.card, style: .continuous)
        content
            .padding(Space.l)
            .background(palette.surface, in: shape)
            .overlay(shape.strokeBorder(palette.accentLine, lineWidth: 1))
            .shadow(color: .black.opacity(palette.dark ? 0.32 : 0.07), radius: 18, y: 8)
            .padding(.horizontal, Space.card)
            .padding(.top, Space.s)
            .accessibilityElement(children: .contain)
    }
}

extension View {
    /// Lets a card's pending step go once the computer turns it down or reports a failure, so its controls
    /// answer again; one still on screen after a while is let go too, since a failure repeating the last
    /// one's words changes nothing the phone can see.
    func releasing<Pending: Equatable>(_ pending: Pending, refused: String?, failure: String?, _ release: @escaping () -> Void) -> some View {
        onChange(of: refused) { was, next in
            if next != nil, next != was { release() }
        }
        .onChange(of: failure) { was, next in
            if next != nil, next != was { release() }
        }
        .task(id: pending) {
            try? await Task.sleep(for: .seconds(15))
            if !Task.isCancelled { release() }
        }
    }
}

/// A card's glyph and its first lines: who asks and what.
struct CardHead: View {
    var symbol: String
    var caption: String
    var count: String?
    var title: String
    var detail: String?
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(alignment: .top, spacing: Space.m) {
            GlyphDisc(symbol: symbol)
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: Space.s) {
                    Text(caption).font(.caption.weight(.semibold)).foregroundStyle(palette.accent).lineLimit(1)
                    Spacer(minLength: 0)
                    if let count { Text(count).font(.caption.monospacedDigit()).foregroundStyle(palette.muted) }
                }
                Text(title).font(.headline).foregroundStyle(palette.ink).fixedSize(horizontal: false, vertical: true)
                if let detail, !detail.isEmpty {
                    Text(detail).font(.subheadline).foregroundStyle(palette.inkDim).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }
}

/// A labelled block that opens on a tap, for what is there to read only on request.
struct Disclosure<Inner: View>: View {
    var label: String
    var symbol: String
    @Binding var open: Bool
    @ViewBuilder var inner: () -> Inner
    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.glide) { open.toggle() }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: symbol).font(.caption.weight(.semibold))
                    Text(label).font(.footnote.weight(.semibold))
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.down").font(.caption2.weight(.bold)).rotationEffect(.degrees(open ? 180 : 0))
                }
                .foregroundStyle(palette.muted)
                .padding(.horizontal, Space.m)
                .frame(height: 38)
                .contentShape(Rectangle())
            }
            .buttonStyle(.target)
            .accessibilityValue(open ? "Expanded" : "Collapsed")
            if open {
                ScrollView {
                    inner()
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 12)
                        .padding(.bottom, 12)
                }
                .frame(maxHeight: 180)
                .fixedSize(horizontal: false, vertical: true)
                .transition(.opacity)
            }
        }
        .background(palette.codeSurface, in: RoundedRectangle(cornerRadius: Radius.block, style: .continuous))
    }
}

/// A choice a thread raised for the user. A tap picks an option, starting from the recommended one,
/// and Send Answer sends it, as on the desktop; the user's own words go through a field of their own.
/// `count` is how many wait.
struct DecisionCard: View {
    var decision: MobileDecision
    var count: Int
    var refused: String?
    var failure: String?
    var onAnswer: (String) -> Void
    @Environment(\.palette) private var palette
    @State private var selected: String?
    @State private var answered: String?
    @State private var contextOpen = false
    @State private var writing = false
    @State private var own = ""

    init(decision: MobileDecision, count: Int, refused: String?, failure: String?, onAnswer: @escaping (String) -> Void) {
        self.decision = decision
        self.count = count
        self.refused = refused
        self.failure = failure
        self.onAnswer = onAnswer
        _selected = State(initialValue: Self.recommended(decision))
    }

    private static func recommended(_ decision: MobileDecision) -> String? {
        decision.options.first { $0.recommended == true }?.label
    }

    /// The selection, while it still names one of the options.
    private var choice: String? {
        decision.options.contains { $0.label == selected } ? selected : nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            CardHead(symbol: "signpost.right.and.left.fill", caption: decision.from.map { "\($0) · Needs your decision" } ?? "Needs your decision", count: count > 1 ? "1 of \(count)" : nil, title: decision.question)
            ViewThatFits(in: .vertical) {
                choices
                ScrollView { choices }.scrollBounceBehavior(.basedOnSize)
            }
            .frame(maxHeight: 460)
        }
        .modifier(CardFrame())
        .sensoryFeedback(.selection, trigger: selected)
        .sensoryFeedback(.success, trigger: answered) { _, next in next != nil }
        .alert("Your Answer", isPresented: $writing) {
            TextField("Answer", text: $own)
            Button("Cancel", role: .cancel) {}
            Button("Send") { answer(own.trimmingCharacters(in: .whitespacesAndNewlines)) }
                .disabled(own.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        } message: {
            Text(decision.question)
        }
        .onChange(of: decision.id) {
            selected = Self.recommended(decision)
        }
        .releasing(answered, refused: refused, failure: failure) { answered = nil }
    }

    /// The context, the options and the ways to answer, which scroll together once they outgrow the card.
    private var choices: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let context = decision.context, !context.isEmpty {
                Disclosure(label: "Context", symbol: "text.alignleft", open: $contextOpen) {
                    Text(context).font(.subheadline).foregroundStyle(palette.inkDim).textSelection(.enabled)
                }
            }
            if !decision.options.isEmpty {
                VStack(spacing: 8) {
                    ForEach(decision.options, id: \.label) { option(for: $0) }
                }
                send
            }
            Button {
                own = ""
                writing = true
            } label: {
                if decision.options.isEmpty {
                    ActionLabel(title: "Answer…")
                } else {
                    Text("Other Answer…")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(palette.inkDim)
                        .frame(maxWidth: .infinity, minHeight: 44)
                        .contentShape(Rectangle())
                }
            }
            .buttonStyle(.press)
            .disabled(answered != nil)
            .opacity(answered != nil ? 0.45 : 1)
        }
    }

    private var send: some View {
        let sending = answered != nil
        let ready = choice != nil && !sending
        return Button {
            if let choice { answer(choice) }
        } label: {
            ActionLabel(title: sending ? "Sending…" : "Send Answer", busy: sending, enabled: ready || sending)
        }
        .buttonStyle(.press)
        .disabled(!ready)
    }

    private func answer(_ text: String) {
        guard !text.isEmpty, answered == nil else { return }
        answered = text
        onAnswer(text)
    }

    private func option(for option: MobileDecision.Option) -> some View {
        let picked = choice == option.label
        let recommended = option.recommended == true
        return Button { selected = option.label } label: {
            HStack(alignment: .center, spacing: 12) {
                Image(systemName: picked ? "checkmark.circle.fill" : "circle")
                    .font(.title3)
                    .foregroundStyle(picked ? palette.accent : palette.quietSoft)
                    .contentTransition(.symbolEffect(.replace))
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    if recommended {
                        Text("Recommended").font(.caption2.weight(.semibold)).foregroundStyle(palette.accent)
                    }
                    Text(option.label).font(.body.weight(.semibold)).foregroundStyle(palette.ink)
                    if let description = option.description, !description.isEmpty {
                        Text(description).font(.footnote).foregroundStyle(palette.muted).fixedSize(horizontal: false, vertical: true)
                    }
                }
                .multilineTextAlignment(.leading)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 11)
            .frame(maxWidth: .infinity, minHeight: 52, alignment: .leading)
            .background(picked ? palette.accentSurface : palette.raised, in: RoundedRectangle(cornerRadius: Radius.row, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: Radius.row, style: .continuous)
                    .strokeBorder(picked ? palette.accent : .clear, lineWidth: 1.5)
            )
            .contentShape(RoundedRectangle(cornerRadius: Radius.row, style: .continuous))
            .animation(.touch, value: picked)
        }
        .buttonStyle(.press)
        .disabled(answered != nil)
        .opacity(answered != nil && answered != option.label ? 0.45 : 1)
        .accessibilityLabel(recommended ? "\(option.label), recommended" : option.label)
        .accessibilityHint(option.description ?? "")
        .accessibilityAddTraits(picked ? [.isSelected] : [])
    }
}

/// The threads the open coordinator suggested. Each title opens its brief, whose full prompt stays
/// shut until asked for, and each starts on its own. The card folds to its first line.
struct SuggestionsCard: View {
    var suggestions: [MobileSuggestion]
    var refused: String?
    var failure: String?
    var onStart: (String) -> Void
    @Environment(\.palette) private var palette
    @State private var folded = false
    @State private var opened: String?
    @State private var promptOpen = false
    /// Starts on their way that the computer has yet to show, each with the error its row showed when tapped.
    @State private var asked: [String: String?] = [:]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button {
                withAnimation(.glide) { folded.toggle() }
            } label: {
                HStack(alignment: .center, spacing: 12) {
                    GlyphDisc(symbol: "rectangle.stack.badge.plus")
                    VStack(alignment: .leading, spacing: 1) {
                        Text("Suggested threads").font(.caption.weight(.semibold)).foregroundStyle(palette.accent)
                        Text(suggestions.count == 1 ? "1 thread to start" : "\(suggestions.count) threads to start").font(.headline).foregroundStyle(palette.ink)
                    }
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.down")
                        .font(.footnote.weight(.bold))
                        .foregroundStyle(palette.quiet)
                        .rotationEffect(.degrees(folded ? -90 : 0))
                }
            }
            .buttonStyle(.target)
            .accessibilityValue(folded ? "Collapsed" : "Expanded")
            if !folded {
                ViewThatFits(in: .vertical) {
                    rows
                    ScrollView { rows }.scrollBounceBehavior(.basedOnSize)
                }
                .frame(maxHeight: 420)
            }
        }
        .modifier(CardFrame())
        .releasing(asked.keys.sorted(), refused: refused, failure: failure) { asked = [:] }
        .onChange(of: suggestions) { _, next in
            // The computer's own word takes over once it shows the start, or a failure the row did not show before.
            asked = asked.filter { id, error in next.contains { $0.id == id && $0.starting != true && $0.error == error } }
            if let opened, !next.contains(where: { $0.id == opened }) { self.opened = nil }
        }
    }

    private var rows: some View {
        VStack(spacing: 8) {
            ForEach(suggestions) { row($0) }
        }
    }

    private func row(_ suggestion: MobileSuggestion) -> some View {
        let open = opened == suggestion.id
        let starting = suggestion.starting == true || asked.keys.contains(suggestion.id)
        return VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .center, spacing: 10) {
                Button {
                    withAnimation(.glide) {
                        opened = open ? nil : suggestion.id
                        promptOpen = false
                    }
                } label: {
                    HStack(spacing: 6) {
                        Text(suggestion.title)
                            .font(.body.weight(.semibold))
                            .foregroundStyle(palette.ink)
                            .lineLimit(open ? nil : 2)
                            .multilineTextAlignment(.leading)
                        Image(systemName: "chevron.down")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(palette.quiet)
                            .rotationEffect(.degrees(open ? 180 : 0))
                        Spacer(minLength: 0)
                    }
                    .frame(minHeight: 36)
                }
                .buttonStyle(.target)
                .accessibilityValue(open ? "Expanded" : "Collapsed")
                .accessibilityHint("Shows its brief")
                Button {
                    asked[suggestion.id] = .some(suggestion.error)
                    onStart(suggestion.id)
                } label: {
                    HStack(spacing: 5) {
                        if starting {
                            Spinner(size: 11, color: palette.accentInk)
                        } else {
                            Image(systemName: "play.fill").font(.caption2)
                        }
                        Text(starting ? "Starting" : "Start")
                    }
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(palette.accentInk)
                    .padding(.horizontal, 14)
                    .frame(height: 34)
                    .background(palette.accent, in: Capsule())
                    .frame(minHeight: 44)
                }
                .buttonStyle(.press)
                .disabled(starting)
                .accessibilityLabel(starting ? "Starting \(suggestion.title)" : "Start \(suggestion.title)")
            }
            if let error = suggestion.error, !starting {
                Text(error).font(.footnote).foregroundStyle(palette.danger).fixedSize(horizontal: false, vertical: true)
            }
            if open {
                VStack(alignment: .leading, spacing: 8) {
                    if let brief = suggestion.brief {
                        briefLine("Your words", brief.intent)
                        briefLine("Done when", brief.doneWhen)
                        briefLine("Delivers", brief.delivers)
                    }
                    Disclosure(label: "Full prompt", symbol: "text.alignleft", open: $promptOpen) {
                        Text(suggestion.prompt).font(.footnote).foregroundStyle(palette.inkDim).textSelection(.enabled)
                    }
                }
                .transition(.opacity)
            }
        }
        .padding(.horizontal, Space.m)
        .padding(.vertical, 6)
        .background(palette.raised, in: RoundedRectangle(cornerRadius: Radius.row, style: .continuous))
    }

    private func briefLine(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label).font(.caption.weight(.semibold)).foregroundStyle(palette.muted)
            Text(value).font(.subheadline).foregroundStyle(palette.inkDim).fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
    }
}

/// The open thread waiting out a usage limit: when it goes, and the one step the desktop offers for it.
/// A session limit resumes on its own, which the user may call off; a weekly one waits for Resume.
struct LimitRow: View {
    var pause: MobileLimitPause
    var refused: String?
    var failure: String?
    var onResume: () -> Void
    var onCancel: () -> Void
    @Environment(\.palette) private var palette
    @State private var acting = false

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { context in
            HStack(alignment: .center, spacing: 10) {
                GlyphDisc(symbol: "hourglass", size: 30)
                Text(Format.limitLabel(pause, now: context.date))
                    .font(.footnote)
                    .foregroundStyle(palette.inkDim)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 4)
                Button {
                    acting = true
                    if pause.resumesOnItsOwn { onCancel() } else { onResume() }
                } label: {
                    HStack(spacing: 5) {
                        if acting { Spinner(size: 11, color: pause.resumesOnItsOwn ? palette.ink : palette.accentInk) }
                        Text(pause.resumesOnItsOwn ? "Cancel Auto-Resume" : "Resume")
                    }
                    .lineLimit(1)
                    .fixedSize()
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(pause.resumesOnItsOwn ? palette.ink : palette.accentInk)
                    .padding(.horizontal, Space.m)
                    .frame(minHeight: 34)
                    .background(pause.resumesOnItsOwn ? palette.raised : palette.accent, in: Capsule())
                    .frame(minHeight: 44)
                }
                .buttonStyle(.press)
                .disabled(acting)
            }
        }
        .padding(.leading, Space.m)
        .padding(.trailing, Space.s)
        .padding(.vertical, 6)
        .background(palette.surface, in: RoundedRectangle(cornerRadius: Radius.bubble, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Radius.bubble, style: .continuous).strokeBorder(palette.lineSoft))
        .padding(.horizontal, Space.card)
        .padding(.top, Space.s)
        .accessibilityElement(children: .contain)
        .releasing(acting, refused: refused, failure: failure) { acting = false }
    }
}
