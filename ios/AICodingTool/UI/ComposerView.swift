import SwiftUI

/// The composer sits above the keyboard and never scrolls with the transcript. Return inserts a
/// newline; sending is the button, or Command-Return on a hardware keyboard.
/// A command of this thread's the computer turned down: a message's words, or the question it answered.
struct ComposerReturned: Equatable {
    var id: String
    var text: String?
    var answer: String?
}

struct ComposerView<Above: View>: View {
    var model: PhoneModel
    var draftKey: String
    var running: Bool
    var settings: MobileThreadSettings
    var question: PendingQuestion?
    var returned: ComposerReturned?
    var onSend: (String) -> Void
    var onSteer: ((String) -> Void)?
    var onStop: (() -> Void)?
    var onAnswer: ((PendingQuestion, String) -> Void)?
    var onSettings: () -> Void
    @ViewBuilder var above: Above

    @Environment(\.palette) private var palette
    @State private var draft = ""
    @State private var given: String?
    @State private var seenHandBack: UUID?
    @FocusState private var focused: Bool

    private var blocked: Bool { question?.blocking == true }
    private var typed: Bool { !blocked && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    /// With words typed during a run, the right-most button queues them, so a thumb on its usual spot never stops the run.
    private var queueing: Bool { running && typed }

    var body: some View {
        let summary = model.catalog.summary(settings)
        VStack(spacing: 0) {
            if model.waiting > 0 {
                HStack(spacing: 6) {
                    Image(systemName: "icloud.slash")
                    Text("\(model.waiting) waiting · offline")
                    Spacer()
                }
                .font(.footnote)
                .foregroundStyle(palette.muted)
                .padding(.horizontal, 16)
                .padding(.bottom, 6)
                .accessibilityElement(children: .combine)
            }
            if let question, let onAnswer {
                QuestionPromptView(question: question, refused: returned?.answer != nil ? returned?.id : nil, onSubmit: { onAnswer(question, $0) })
                    .id("\(question.runId)|\(question.requestId)|\(question.questionId)")
            }
            above
            VStack(spacing: 8) {
                if !blocked {
                    TextField("Ask \(model.catalog.engineLabel(settings.engine)) to work on anything", text: $draft, axis: .vertical)
                        .lineLimit(1...7)
                        .focused($focused)
                        .foregroundStyle(palette.ink)
                        .textInputAutocapitalization(.sentences)
                        .accessibilityLabel("Message")
                        .onKeyPress(keys: [.return], phases: .down) { press in
                            guard press.modifiers.contains(.command) else { return .ignored }
                            send(onSend)
                            return .handled
                        }
                }
                HStack(spacing: 8) {
                    Button(action: onSettings) {
                        // The summary gives up its axis names, then its values, before the run's buttons give up any room.
                        ViewThatFits(in: .horizontal) {
                            settingsSummary(summary, axes: true)
                            settingsSummary(summary, axes: false)
                            Image(systemName: "slider.horizontal.3")
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(palette.inkDim)
                                .frame(width: 34, height: 34)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Thread settings: \([summary.mode, summary.model, summary.effort].compactMap { $0 }.joined(separator: ", "))")
                    Spacer(minLength: 4)
                    if queueing {
                        if let onStop { stopButton(onStop, aside: true) }
                        if let onSteer {
                            pill("Steer now", symbol: "bolt", primary: false) { send(onSteer) }
                                .accessibilityHint("Sends it into the running turn")
                        }
                        pill("Queue", symbol: "arrow.turn.down.right", primary: true) { send(onSend) }
                            .accessibilityHint("Sends it when this run ends")
                    } else if running, let onStop {
                        stopButton(onStop, aside: false)
                    } else if !blocked {
                        Button { send(onSend) } label: {
                            Image(systemName: "arrow.up")
                                .font(.body.weight(.bold))
                                .foregroundStyle(typed ? palette.accentInk : palette.quiet)
                                .frame(width: 34, height: 34)
                                .background(typed ? palette.accent : palette.raised, in: Circle())
                        }
                        .buttonStyle(.plain)
                        .disabled(!typed)
                        .accessibilityLabel("Send")
                        .keyboardShortcut(.return, modifiers: .command)
                    }
                }
            }
            .padding(12)
            .background(palette.surface, in: RoundedRectangle(cornerRadius: 22))
            .overlay(RoundedRectangle(cornerRadius: 22).strokeBorder(focused ? palette.lineStrong : palette.line))
            .padding(.horizontal, 10)
            .padding(.bottom, 8)
        }
        .padding(.top, 6)
        .background(palette.canvas)
        .onAppear { draft = model.draft(for: draftKey) }
        .onChange(of: draftKey) { _, key in draft = model.draft(for: key) }
        .onChange(of: draft) { _, text in model.keepDraft(text, for: draftKey) }
        .onChange(of: returned) { _, next in
            guard let next, let text = next.text, next.id != given else { return }
            given = next.id
            if draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { draft = text }
        }
        .onChange(of: model.handedBack?.id) { _, id in
            guard let id, id != seenHandBack, let text = model.handedBack?.text else { return }
            seenHandBack = id
            draft = draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? text : "\(draft.trimmingCharacters(in: .whitespacesAndNewlines))\n\n\(text)"
        }
    }

    private func settingsSummary(_ summary: (mode: String, model: String, effort: String?), axes: Bool) -> some View {
        HStack(spacing: 4) {
            settingValue(axes ? "Mode" : nil, summary.mode)
            settingValue(axes ? "Model" : nil, summary.model)
            if let effort = summary.effort { settingValue(axes ? "Effort" : nil, effort) }
            Image(systemName: "chevron.down").font(.caption2.weight(.bold)).foregroundStyle(palette.quiet)
        }
        .lineLimit(1)
        .fixedSize()
    }

    private func settingValue(_ axis: String?, _ value: String) -> some View {
        HStack(spacing: 3) {
            if let axis { Text(axis).font(.caption).foregroundStyle(palette.quiet) }
            Text(value).font(.caption.weight(.medium)).foregroundStyle(palette.inkDim)
        }
        .padding(.trailing, 4)
    }

    private func pill(_ label: String, symbol: String, primary: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(label, systemImage: symbol)
                .font(.footnote.weight(.semibold))
                .lineLimit(1)
                .fixedSize()
                .padding(.horizontal, 12)
                .frame(height: 34)
                .foregroundStyle(primary ? palette.accentInk : palette.ink)
                .background(primary ? palette.accent : palette.raised, in: Capsule())
        }
        .buttonStyle(.plain)
    }

    private func stopButton(_ action: @escaping () -> Void, aside: Bool) -> some View {
        Button(action: action) {
            RoundedRectangle(cornerRadius: 2.5)
                .fill(aside ? palette.ink : palette.contrastInk)
                .frame(width: 11, height: 11)
                .frame(width: 34, height: 34)
                .background(aside ? palette.raised : palette.contrast, in: Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Stop this run")
    }

    private func send(_ how: (String) -> Void) {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        draft = ""
        how(text)
    }
}

extension ComposerView where Above == EmptyView {
    init(model: PhoneModel, draftKey: String, running: Bool, settings: MobileThreadSettings, question: PendingQuestion?, returned: ComposerReturned?, onSend: @escaping (String) -> Void, onSteer: ((String) -> Void)?, onStop: (() -> Void)?, onAnswer: ((PendingQuestion, String) -> Void)?, onSettings: @escaping () -> Void) {
        self.init(model: model, draftKey: draftKey, running: running, settings: settings, question: question, returned: returned, onSend: onSend, onSteer: onSteer, onStop: onStop, onAnswer: onAnswer, onSettings: onSettings) { EmptyView() }
    }
}

/// A question the agent asked: pick an option, or type an answer. Typing stays local until sent.
struct QuestionPromptView: View {
    var question: PendingQuestion
    var refused: String?
    var onSubmit: (String) -> Void
    @Environment(\.palette) private var palette
    @State private var answer: String
    @State private var typed = false
    @State private var submitting = false
    @State private var released: String?

    init(question: PendingQuestion, refused: String?, onSubmit: @escaping (String) -> Void) {
        self.question = question
        self.refused = refused
        self.onSubmit = onSubmit
        _answer = State(initialValue: question.answer ?? "")
        _released = State(initialValue: refused)
    }

    private var chosen: String? {
        !typed && question.options.contains(where: { $0.label == answer }) ? answer : nil
    }

    private var unavailable: Bool { submitting || question.submitting == true }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(question.header.isEmpty ? "Question" : question.header).font(.subheadline.weight(.semibold)).foregroundStyle(palette.ink)
                Spacer()
                Text(question.blocking ? "Waiting for your answer" : "Working while you answer").font(.caption).foregroundStyle(palette.muted)
            }
            Text(question.question).font(.subheadline).foregroundStyle(palette.inkDim)
            ForEach(Array(question.options.enumerated()), id: \.offset) { _, option in
                Button {
                    typed = false
                    answer = option.label
                } label: {
                    HStack(alignment: .top, spacing: 10) {
                        Image(systemName: chosen == option.label ? "largecircle.fill.circle" : "circle")
                            .foregroundStyle(chosen == option.label ? palette.accent : palette.quiet)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(option.label).font(.subheadline.weight(.medium)).foregroundStyle(palette.ink)
                            if !option.description.isEmpty { Text(option.description).font(.footnote).foregroundStyle(palette.muted) }
                        }
                        Spacer(minLength: 0)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(unavailable)
                .accessibilityAddTraits(chosen == option.label ? [.isSelected] : [])
            }
            TextField(question.options.isEmpty ? "Type your answer…" : "Or type your answer…", text: Binding(get: { chosen == nil ? answer : "" }, set: { value in
                typed = true
                answer = value
            }), axis: .vertical)
            .lineLimit(1...4)
            .padding(10)
            .background(palette.sunken, in: RoundedRectangle(cornerRadius: 10))
            .disabled(unavailable)
            .accessibilityLabel("Your answer")
            HStack {
                Spacer()
                Button(question.submitting == true || submitting ? "Sending…" : "Send answer") {
                    let text = answer.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !text.isEmpty, !unavailable else { return }
                    submitting = true
                    onSubmit(text)
                }
                .buttonStyle(.borderedProminent)
                .disabled(unavailable || answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(14)
        .background(palette.surface, in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(palette.line))
        .padding(.horizontal, 10)
        .padding(.bottom, 8)
        .onChange(of: refused) { _, next in
            if let next, next != released {
                released = next
                submitting = false
            }
        }
    }
}
