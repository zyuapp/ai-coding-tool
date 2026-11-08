import AVFoundation
import PhotosUI
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
    /// The words and the pictures, as JPEG data URLs, that go with them.
    var onSend: (String, [String]) -> Void
    var onSteer: ((String, [String]) -> Void)?
    var onStop: (() -> Void)?
    var onAnswer: ((PendingQuestion, String) -> Void)?
    var onSettings: () -> Void
    var quick: QuickSettings? = nil
    @ViewBuilder var above: Above

    @Environment(\.palette) private var palette
    @State private var draft = ""
    @State private var given: String?
    @State private var seenHandBack: UUID?
    @State private var images: [PickedImage] = []
    @State private var picking = false
    @State private var shooting = false
    @State private var picked: [PhotosPickerItem] = []
    @State private var sent = 0
    @State private var finishing = false
    @State private var dictation = DictationTrace()
    @State private var recorder = VoiceRecorder()
    @State private var talk: TalkPhase = .idle
    @State private var talkCancelling = false
    @State private var talkReleased = false
    @State private var talkNote: String?
    @State private var heard = 0
    @State private var talkEnded = false
    @GestureState private var pressing = false
    @Environment(\.scenePhase) private var scenePhase
    @FocusState private var focused: Bool

    private var blocked: Bool { question?.blocking == true }
    private var typed: Bool { !blocked && (!draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !images.isEmpty) }
    /// With words typed during a run, the right-most button queues them, so a thumb on its usual spot never stops the run.
    private var queueing: Bool { running && typed }
    private var canTalk: Bool { model.canDictate && !blocked }

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
            if let talkNote {
                HStack(spacing: 6) {
                    Image(systemName: "mic")
                    Text(talkNote).lineLimit(2)
                    Spacer()
                    Button { self.talkNote = nil } label: { Image(systemName: "xmark").font(.caption.weight(.bold)) }
                        .buttonStyle(.plain)
                        .frame(width: 44, height: 32)
                        .accessibilityLabel("Dismiss")
                }
                .font(.footnote)
                .foregroundStyle(palette.muted)
                .padding(.leading, 16)
                .padding(.bottom, 2)
            }
            if let question, let onAnswer {
                QuestionPromptView(question: question, refused: returned?.answer != nil ? returned?.id : nil, onSubmit: { onAnswer(question, $0) })
                    .id("\(question.runId)|\(question.requestId)|\(question.questionId)")
                    .fitsShortScreens()
            }
            above
            VStack(spacing: 8) {
                if !images.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(images) { image in
                                Image(uiImage: image.thumbnail)
                                    .resizable()
                                    .scaledToFill()
                                    .frame(width: 56, height: 56)
                                    .clipShape(RoundedRectangle(cornerRadius: 10))
                                    .overlay(alignment: .topTrailing) {
                                        Button { images.removeAll { $0.id == image.id } } label: {
                                            Image(systemName: "xmark.circle.fill")
                                                .symbolRenderingMode(.palette)
                                                .foregroundStyle(palette.ink, palette.raised)
                                                .font(.body)
                                        }
                                        .frame(width: 44, height: 44, alignment: .topTrailing)
                                        .contentShape(Rectangle())
                                        .buttonStyle(.plain)
                                        .offset(x: 6, y: -6)
                                        .accessibilityLabel("Remove picture")
                                    }
                                    .accessibilityLabel("Picture to send")
                            }
                        }
                        .padding(.top, 6)
                        .padding(.trailing, 6)
                    }
                }
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
                } else {
                    Label("Answer the question above to continue", systemImage: "questionmark.circle")
                        .font(.body)
                        .foregroundStyle(palette.quiet)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityLabel("Answer the question to continue")
                }
                HStack(spacing: 8) {
                    if talk.active {
                        TalkStrip(phase: talk, levels: recorder.levels, cancelling: talkCancelling)
                    }
                    if !blocked && !talk.active {
                        Menu {
                            Button { picking = true } label: { Label("Photo Library", systemImage: "photo.on.rectangle") }
                            if UIImagePickerController.isSourceTypeAvailable(.camera) {
                                Button { shooting = true } label: { Label("Take Photo", systemImage: "camera") }
                            }
                        } label: {
                            Image(systemName: "plus")
                                .font(.body.weight(.semibold))
                                .foregroundStyle(palette.inkDim)
                                .frame(width: 34, height: 34)
                                .background(palette.raised, in: Circle())
                                .frame(width: 44, height: 44)
                                .contentShape(Rectangle())
                        }
                        .disabled(images.count >= PickedImage.limit)
                        .accessibilityLabel("Add pictures")
                    }
                    if !talk.active {
                    Group {
                        if let quick {
                            Menu {
                                QuickSettingsItems(settings: settings, catalog: model.catalog, quick: quick, onMore: onSettings)
                            } label: {
                                settingsChip(summary)
                            }
                        } else {
                            Button(action: onSettings) { settingsChip(summary) }
                                .buttonStyle(.plain)
                        }
                    }
                    .accessibilityLabel("Thread settings: \([summary.mode, summary.model, summary.effort].compactMap { $0 }.joined(separator: ", "))")
                    Spacer(minLength: 4)
                    }
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
                    } else if canTalk || talk.active {
                        talkButton
                    } else if !blocked {
                        Button { send(onSend) } label: {
                            Image(systemName: "arrow.up")
                                .font(.body.weight(.bold))
                                .foregroundStyle(typed ? palette.accentInk : palette.muted)
                                .frame(width: 34, height: 34)
                                .background(typed ? palette.accent : palette.raised, in: Circle())
                                .animation(.snappy(duration: 0.2), value: typed)
                                .frame(width: 44, height: 44)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .disabled(!typed)
                        .accessibilityLabel("Send")
                        .keyboardShortcut(.return, modifiers: .command)
                    }
                }
            }
            .padding(.top, 14)
            .padding(.leading, 14)
            .padding(.trailing, 9)
            .padding(.bottom, 5)
            .composerSurface(palette, focused: focused)
            .overlay(alignment: .bottomTrailing) {
                if talk == .listening {
                    TalkCancelTarget(armed: talkCancelling)
                        .padding(.trailing, 14)
                        .padding(.bottom, 27 + TalkPhase.cancelDistance - 15)
                        .transition(.opacity.combined(with: .move(edge: .bottom)))
                }
            }
            .padding(.horizontal, 12)
            .padding(.bottom, 8)
        }
        .padding(.top, 6)
        .composerGround(palette)
        .sensoryFeedback(.impact(weight: .light), trigger: sent)
        .sensoryFeedback(.impact(weight: .medium), trigger: heard)
        .sensoryFeedback(.selection, trigger: talkCancelling)
        .onChange(of: scenePhase) { _, phase in
            if phase != .active { cancelTalk() }
        }
        .onChange(of: pressing) { _, held in
            guard !held else { return }
            /// A touch the system took away, such as by an alert, never ends, so the hold is dropped.
            Task { @MainActor in
                await Task.yield()
                if !talkEnded { cancelTalk() }
            }
        }
        .photosPicker(isPresented: $picking, selection: $picked, maxSelectionCount: max(1, PickedImage.limit - images.count), matching: .images)
        .onChange(of: picked) { _, items in
            guard !items.isEmpty else { return }
            picked = []
            Task {
                for item in items {
                    guard images.count < PickedImage.limit, let data = try? await item.loadTransferable(type: Data.self), let image = await PickedImage.make(from: data) else { continue }
                    images.append(image)
                }
            }
        }
        .fullScreenCover(isPresented: $shooting) {
            CameraPicker { data in
                shooting = false
                guard let data else { return }
                Task { if images.count < PickedImage.limit, let image = await PickedImage.make(from: data) { images.append(image) } }
            }
            .ignoresSafeArea()
        }
        .onAppear { draft = model.draft(for: draftKey) }
        .onChange(of: draft) { old, text in
            if focused { dictation.record(from: old, to: text) }
            model.keepDraft(text, for: draftKey)
        }
        .onChange(of: returned) { _, next in
            guard let next, let text = next.text, next.id != given else { return }
            given = next.id
            if draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { draft = text }
        }
        .onChange(of: model.handedBack?.id) { _, id in
            guard let id, id != seenHandBack, let text = model.handedBack?.text else { return }
            seenHandBack = id
            focused = true
            draft = draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? text : "\(draft.trimmingCharacters(in: .whitespacesAndNewlines))\n\n\(text)"
        }
    }

    /// The summary gives up its axis names, then its values, before the run's buttons give up any room.
    private func settingsChip(_ summary: (mode: String, model: String, effort: String?)) -> some View {
        ViewThatFits(in: .horizontal) {
            settingsSummary([summary.model, summary.effort, summary.mode].compactMap { $0 })
            settingsSummary([summary.model, summary.effort].compactMap { $0 })
            settingsSummary([summary.model])
            Image(systemName: "slider.horizontal.3")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(palette.inkDim)
                .frame(width: 34, height: 34)
                .background(palette.raised, in: Circle())
        }
        .frame(minHeight: 44)
        .contentShape(Rectangle())
    }

    /// The thread's model, effort and mode as one chip, dropping from the end when room runs out.
    private func settingsSummary(_ values: [String]) -> some View {
        HStack(spacing: 5) {
            Text(values.joined(separator: " · ")).font(.footnote.weight(.semibold)).foregroundStyle(palette.inkDim)
            Image(systemName: "chevron.down").font(.caption2.weight(.bold)).foregroundStyle(palette.muted)
        }
        .lineLimit(1)
        .fixedSize()
        .padding(.horizontal, 12)
        .frame(height: 34)
        .background(palette.raised, in: Capsule())
    }

    private func pill(_ label: String, symbol: String, primary: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(label, systemImage: symbol)
                .font(.footnote.weight(.semibold))
                .lineLimit(1)
                .fixedSize()
                .padding(.horizontal, 13)
                .frame(height: 34)
                .foregroundStyle(primary ? palette.accentInk : palette.ink)
                .background(primary ? palette.accent : palette.raised, in: Capsule())
                .frame(minHeight: 44)
                .contentShape(Rectangle())
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
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Stop this run")
    }

    /// Send that also listens: a tap sends, a hold records until the finger lifts, and a finger slid
    /// up to the mark above it cancels. Empty, it shows a microphone, since holding is all it can do.
    private var talkButton: some View {
        let microphone = !typed || talk.active
        let lit = typed || talk == .listening || talk == .starting
        return ZStack {
            Circle()
                .fill(talkCancelling ? palette.raised : lit ? palette.accent : palette.raised)
                .frame(width: 34, height: 34)
                .scaleEffect(talk == .listening && !talkCancelling ? 1.25 : 1)
            if talk == .transcribing {
                ProgressView().tint(palette.inkDim)
            } else {
                Image(systemName: microphone ? "mic.fill" : "arrow.up")
                    .font(.body.weight(.bold))
                    .foregroundStyle(talkCancelling ? palette.muted : lit ? palette.accentInk : palette.inkDim)
            }
        }
        .animation(.snappy(duration: 0.2), value: talk)
        .animation(.snappy(duration: 0.2), value: typed)
        .frame(width: 44, height: 44)
        .contentShape(Rectangle())
        .gesture(
            DragGesture(minimumDistance: 0)
                .updating($pressing) { _, state, _ in state = true }
                .onChanged { value in pressMoved(value.translation.height) }
                .onEnded { value in pressEnded(value.translation.height) }
        )
        .background {
            Button("") { send(onSend) }
                .keyboardShortcut(.return, modifiers: .command)
                .opacity(0)
                .accessibilityHidden(true)
        }
        .accessibilityElement()
        .accessibilityLabel(typed ? "Send" : "Hold to talk")
        .accessibilityHint(typed ? "Hold to add what you say" : "Hold, speak, and let go to send")
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { send(onSend) }
    }

    private func pressMoved(_ rise: CGFloat) {
        switch talk {
        case .idle:
            talk = .pressing
            talkReleased = false
            talkEnded = false
            Task { @MainActor in
                try? await Task.sleep(for: TalkPhase.holdDelay)
                if talk == .pressing { startTalking() }
            }
        case .listening, .starting:
            let cancelling = rise < -TalkPhase.cancelDistance
            if cancelling != talkCancelling { talkCancelling = cancelling }
        default:
            break
        }
    }

    private func pressEnded(_ rise: CGFloat) {
        talkEnded = true
        switch talk {
        case .pressing:
            talk = .idle
            send(onSend)
        case .starting:
            talkReleased = true
        case .listening:
            if rise < -TalkPhase.cancelDistance { cancelTalk() } else { finishTalking() }
        default:
            break
        }
    }

    private func startTalking() {
        talkNote = nil
        talkCancelling = false
        /// The first hold only asks, since the alert takes the finger; the next hold listens.
        guard AVAudioApplication.shared.recordPermission != .undetermined else {
            talk = .idle
            Task { @MainActor in
                if await AVAudioApplication.requestRecordPermission() { talkNote = "Hold again to talk." }
            }
            return
        }
        talk = .starting
        Dictation.finish()
        Task { @MainActor in
            do {
                try await recorder.start()
            } catch {
                talk = .idle
                talkNote = error.localizedDescription
                return
            }
            if talkReleased {
                if talkCancelling { cancelTalk() } else {
                    talk = .listening
                    finishTalking()
                }
                return
            }
            talk = .listening
            heard += 1
        }
    }

    private func cancelTalk() {
        guard talk.active || talk == .pressing else { return }
        if talk != .transcribing { recorder.cancel() }
        talk = .idle
        talkCancelling = false
    }

    /// What was heard is written down by the computer, follows whatever was typed, and goes as one message.
    private func finishTalking() {
        talkCancelling = false
        guard let wav = recorder.stop() else { talk = .idle; return }
        talk = .transcribing
        Task { @MainActor in
            defer { talk = .idle }
            do {
                let words = try await model.transcribe(wav).trimmingCharacters(in: .whitespacesAndNewlines)
                guard !words.isEmpty else {
                    talkNote = "Didn't catch anything, so nothing was sent."
                    return
                }
                let typedSoFar = draft.trimmingCharacters(in: .whitespacesAndNewlines)
                draft = typedSoFar.isEmpty ? words : "\(typedSoFar) \(words)"
                commit(onSend)
            } catch {
                talkNote = error.localizedDescription
            }
        }
    }

    /// Sends what is typed. Dictation still running stops first, and its last words go with the message.
    private func send(_ how: @escaping (String, [String]) -> Void) {
        guard !finishing else { return }
        guard focused else { return commit(how) }
        Dictation.finish()
        guard dictation.recent() else { return commit(how) }
        finishing = true
        Task { @MainActor in
            var last = draft
            var quiet = 0
            for _ in 0..<15 where quiet < 4 {
                try? await Task.sleep(for: .milliseconds(100))
                quiet = draft == last ? quiet + 1 : 0
                last = draft
            }
            finishing = false
            commit(how)
        }
    }

    private func commit(_ how: (String, [String]) -> Void) {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        let sources = images.map(\.source)
        guard !text.isEmpty || !sources.isEmpty else { return }
        draft = ""
        images = []
        dictation.reset()
        sent += 1
        how(text, sources)
    }
}

extension ComposerView where Above == EmptyView {
    init(model: PhoneModel, draftKey: String, running: Bool, settings: MobileThreadSettings, question: PendingQuestion?, returned: ComposerReturned?, onSend: @escaping (String, [String]) -> Void, onSteer: ((String, [String]) -> Void)?, onStop: (() -> Void)?, onAnswer: ((PendingQuestion, String) -> Void)?, onSettings: @escaping () -> Void, quick: QuickSettings? = nil) {
        self.init(model: model, draftKey: draftKey, running: running, settings: settings, question: question, returned: returned, onSend: onSend, onSteer: onSteer, onStop: onStop, onAnswer: onAnswer, onSettings: onSettings, quick: quick) { EmptyView() }
    }
}

/// What the settings chip changes in place, without opening the sheet.
struct QuickSettings {
    /// A thread keeps its engine; a draft may pick any.
    var locked: Bool
    var onPolicy: (String) -> Void
    var onModel: (String, String) -> Void
    var onEffort: (String, String) -> Void
    var onFastMode: (Bool) -> Void
}

/// The settings chip's menu: the mode inline, since it changes most, then the model and effort a level down.
struct QuickSettingsItems: View {
    var settings: MobileThreadSettings
    var catalog: EngineCatalog
    var quick: QuickSettings
    var onMore: () -> Void

    var body: some View {
        let known = catalog.knows(settings.engine)
        let coordinating = settings.coordinating == true
        let headings = catalog.library(engine: settings.engine, locked: quick.locked).filter { !$0.locked && !$0.models.isEmpty }
        let efforts = known && settings.model != nil ? catalog.efforts(settings.engine, model: settings.model!, coordinating: coordinating) : []
        let chosenEffort = settings.model.map { catalog.effortForModel(settings.engine, model: $0, effort: settings.effort, coordinating: coordinating) }
        if known {
            Section("Mode") {
                Picker("Mode", selection: Binding(get: { settings.policy }, set: quick.onPolicy)) {
                    ForEach(catalog.policies(settings.engine), id: \.id) { policy in
                        Label(policy.label, systemImage: ThreadSettingsSheet.policySymbol(policy.id)).tag(policy.id)
                    }
                }
                .pickerStyle(.inline)
            }
        }
        Section {
            if !headings.isEmpty {
                Picker(selection: Binding(get: { "\(settings.engine)|\(settings.model ?? "")" }, set: { value in
                    let parts = value.split(separator: "|", maxSplits: 1).map(String.init)
                    if parts.count == 2 { quick.onModel(parts[0], parts[1]) }
                })) {
                    ForEach(headings, id: \.key) { heading in
                        Section(headings.count > 1 ? heading.label : "") {
                            ForEach(heading.models, id: \.id) { spec in
                                Text(spec.label).tag("\(heading.engine)|\(spec.id)")
                            }
                        }
                    }
                } label: {
                    Label("Model", systemImage: "cpu")
                    Text(catalog.model(settings.engine, settings.model)?.label ?? settings.model ?? "None")
                }
                .pickerStyle(.menu)
            }
            if !efforts.isEmpty, let chosenEffort {
                Picker(selection: Binding(get: { chosenEffort }, set: { quick.onEffort(settings.engine, $0) })) {
                    ForEach(efforts, id: \.id) { Text($0.label).tag($0.id) }
                } label: {
                    Label("Effort", systemImage: "gauge.with.dots.needle.50percent")
                    Text(efforts.first { $0.id == chosenEffort }?.label ?? chosenEffort)
                }
                .pickerStyle(.menu)
            }
            if catalog.fastMode(settings.engine) {
                Toggle(isOn: Binding(get: { settings.fastMode == true }, set: quick.onFastMode)) {
                    Label("Fast Mode", systemImage: "hare")
                }
            }
        }
        Section {
            Button(action: onMore) { Label("All Settings…", systemImage: "slider.horizontal.3") }
        }
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
        let empty = answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "questionmark.bubble.fill")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(palette.accent)
                    .frame(width: 34, height: 34)
                    .background(palette.accentChip, in: Circle())
                VStack(alignment: .leading, spacing: 3) {
                    Text((question.header.isEmpty ? "Question" : question.header) + (question.blocking ? " · Waiting for you" : " · Still working"))
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(palette.accent)
                    Text(question.question).font(.headline).foregroundStyle(palette.ink).fixedSize(horizontal: false, vertical: true)
                }
            }
            if !question.options.isEmpty {
                VStack(spacing: 0) {
                    ForEach(Array(question.options.enumerated()), id: \.offset) { index, option in
                        if index > 0 { palette.line.frame(height: 0.5).padding(.leading, 14) }
                        Button {
                            typed = false
                            answer = option.label
                        } label: {
                            HStack(spacing: 12) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(option.label).font(.subheadline.weight(.semibold)).foregroundStyle(chosen == option.label ? palette.accent : palette.ink)
                                    if !option.description.isEmpty { Text(option.description).font(.footnote).foregroundStyle(palette.muted) }
                                }
                                Spacer(minLength: 0)
                                Image(systemName: "checkmark")
                                    .font(.body.weight(.semibold))
                                    .foregroundStyle(palette.accent)
                                    .opacity(chosen == option.label ? 1 : 0)
                                    .accessibilityHidden(true)
                            }
                            .padding(.horizontal, 14)
                            .padding(.vertical, 12)
                            .background(chosen == option.label ? palette.accentChip : Color.clear)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .disabled(unavailable)
                        .accessibilityAddTraits(chosen == option.label ? [.isSelected] : [])
                    }
                }
                .background(palette.raised)
                .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            }
            TextField(question.options.isEmpty ? "Type your answer…" : "Or type your own answer…", text: Binding(get: { chosen == nil ? answer : "" }, set: { value in
                typed = true
                answer = value
            }), axis: .vertical)
            .lineLimit(1...4)
            .font(.subheadline)
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .background(palette.raised, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .disabled(unavailable)
            .accessibilityLabel("Your answer")
            Button {
                let text = answer.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !text.isEmpty, !unavailable else { return }
                submitting = true
                onSubmit(text)
            } label: {
                HStack(spacing: 6) {
                    if unavailable { ProgressView().controlSize(.small).tint(palette.accentInk) }
                    Text(unavailable ? "Sending…" : "Send Answer")
                }
                .font(.body.weight(.semibold))
                .foregroundStyle(empty && !unavailable ? palette.muted : palette.accentInk)
                .frame(maxWidth: .infinity, minHeight: 48)
                .background(empty && !unavailable ? palette.raised : palette.accent, in: Capsule())
                .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            .disabled(unavailable || empty)
        }
        .padding(16)
        .background(palette.surface, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 24, style: .continuous).strokeBorder(palette.accentLine, lineWidth: 1))
        .shadow(color: .black.opacity(palette.dark ? 0.35 : 0.08), radius: 16, y: 6)
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
        .onChange(of: refused) { _, next in
            if let next, next != released {
                released = next
                submitting = false
            }
        }
    }
}

/// A picture waiting to be sent: shrunk on the phone so a camera photo never crosses the line whole.
struct PickedImage: Identifiable {
    /// As many as the desktop's composer strip holds.
    static let limit = 6
    /// The longest side a sent picture keeps: the most a model reads, and small enough to send as PNG.
    static let longestSide: CGFloat = 1568
    /// The computer's `MAX_PHONE_IMAGE_LENGTH`; a busier picture shrinks until it fits.
    static let maxSourceLength = 8 * 1024 * 1024

    let id = UUID()
    let thumbnail: UIImage
    /// A PNG data URL, the one image format the computer keeps attachments in.
    let source: String

    static func make(from data: Data) async -> PickedImage? {
        await Task.detached(priority: .userInitiated) {
            guard let original = UIImage(data: data) else { return nil }
            var side = min(longestSide, max(original.size.width, original.size.height))
            while side >= 256 {
                let scale = side / max(original.size.width, original.size.height)
                let size = CGSize(width: (original.size.width * scale).rounded(), height: (original.size.height * scale).rounded())
                let format = UIGraphicsImageRendererFormat()
                format.scale = 1
                format.opaque = true
                let shrunk = UIGraphicsImageRenderer(size: size, format: format).image { _ in original.draw(in: CGRect(origin: .zero, size: size)) }
                guard let png = shrunk.pngData() else { return nil }
                let source = "data:image/png;base64,\(png.base64EncodedString())"
                if source.utf8.count <= maxSourceLength {
                    let thumbnail = shrunk.preparingThumbnail(of: CGSize(width: 168, height: 168 * size.height / max(size.width, 1))) ?? shrunk
                    return PickedImage(thumbnail: thumbnail, source: source)
                }
                side *= 0.75
            }
            return nil
        }.value
    }
}

/// The camera, handing back one photo or nothing.
struct CameraPicker: UIViewControllerRepresentable {
    var onDone: (Data?) -> Void

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(onDone: onDone) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let onDone: (Data?) -> Void

        init(onDone: @escaping (Data?) -> Void) {
            self.onDone = onDone
        }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            onDone((info[.originalImage] as? UIImage)?.jpegData(compressionQuality: 0.9))
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            onDone(nil)
        }
    }
}

extension View {
    /// The composer's own field: Liquid Glass on iOS 26, so the transcript reads through it as it scrolls beneath.
    @ViewBuilder func composerSurface(_ palette: Palette, focused: Bool) -> some View {
        let shape = RoundedRectangle(cornerRadius: 26, style: .continuous)
        if #available(iOS 26, *) {
            glassEffect(.regular.tint(palette.surface.opacity(0.55)).interactive(), in: shape)
        } else {
            background(palette.surface, in: shape)
                .overlay(shape.strokeBorder(focused ? palette.lineStrong : palette.lineSoft))
                .shadow(color: .black.opacity(palette.dark ? 0.3 : 0.06), radius: 12, y: 4)
        }
    }

    /// A bar along the bottom that content scrolls beneath, with the system's edge effect on iOS 26.
    @ViewBuilder func bottomBar<Bar: View>(@ViewBuilder _ bar: () -> Bar) -> some View {
        if #available(iOS 26, *) {
            safeAreaBar(edge: .bottom, spacing: 0, content: bar)
        } else {
            safeAreaInset(edge: .bottom, spacing: 0, content: bar)
        }
    }

    /// What lies behind the composer: nothing on iOS 26, where the transcript scrolls under it, else the page.
    @ViewBuilder func composerGround(_ palette: Palette) -> some View {
        if #available(iOS 26, *) {
            self
        } else {
            background(palette.canvas)
        }
    }
}

/// On a screen too short for a whole card, such as a phone in landscape, the card scrolls inside a capped height so the transcript and bar stay reachable. The card keeps one structure either way, so turning the phone keeps what it holds.
private struct ShortScreenFit: ViewModifier {
    @Environment(\.verticalSizeClass) private var sizeClass

    func body(content: Content) -> some View {
        ScrollView { content }
            .scrollBounceBehavior(.basedOnSize)
            .frame(maxHeight: sizeClass == .compact ? 170 : nil)
            .fixedSize(horizontal: false, vertical: sizeClass != .compact)
    }
}

extension View {
    func fitsShortScreens() -> some View { modifier(ShortScreenFit()) }
}

/// The system's dictation in the field that is typing.
@MainActor
private enum Dictation {
    fileprivate static weak var responder: UIResponder?

    /// Stops any dictation by handing focus away and straight back, so the keyboard stays up.
    static func finish() {
        responder = nil
        UIApplication.shared.sendAction(#selector(UIResponder.reportFirstResponder(_:)), to: nil, from: nil, for: nil)
        guard let field = responder else { return }
        field.resignFirstResponder()
        field.becomeFirstResponder()
    }
}

private extension UIResponder {
    @objc func reportFirstResponder(_ sender: Any?) {
        Dictation.responder = self
    }
}
