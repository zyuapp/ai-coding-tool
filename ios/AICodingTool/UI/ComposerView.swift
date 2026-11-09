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
    var quick: QuickSettings
    /// Where the "/" menu is read from; nil offers none.
    var commandScope: PhoneModel.CommandScope?
    @ViewBuilder var above: Above

    @Environment(\.palette) private var palette
    @State private var draft = ""
    @State private var given: String?
    @State private var images: [PickedImage] = []
    @State private var tray: ComposerTray?
    @State private var shooting = false
    @State private var picking = false
    @State private var picked: [PhotosPickerItem] = []
    @State private var sent = 0
    /// The words last sent, which a late edit from the system, such as dictation finishing, must not put back.
    @State private var lastSent: (text: String, at: Date)?
    @State private var finishing = false
    @State private var dictation = DictationTrace()
    @State private var recorder = VoiceRecorder()
    @State private var talk: TalkPhase = .idle
    @State private var talkCancelling = false
    @State private var talkReleased = false
    @State private var talkNote: String?
    @State private var heard = 0
    @State private var talkEnded = false
    /// A finger is on the microphone, so only the touch's first report starts or finishes anything.
    @State private var talkTouching = false
    /// The press outlasted a tap, so letting go adds the words and sliding up cancels.
    @State private var talkHeld = false
    /// A tap left the microphone listening, until the next press adds the words.
    @State private var talkHandsFree = false
    @State private var pressedAt = Date.distantPast
    @State private var commandsPicked = 0
    @GestureState private var pressing = false
    @Environment(\.scenePhase) private var scenePhase
    @FocusState private var focused: Bool

    private var blocked: Bool { question?.blocking == true }
    private var typed: Bool { !blocked && (!draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !images.isEmpty) }
    /// With words typed during a run, the right-most button queues them, so a thumb on its usual spot never stops the run.
    private var queueing: Bool { running && typed }
    private var canTalk: Bool { model.canDictate && !blocked }
    private var usage: MobileComposerUsage? { model.view.usage?.composer }
    /// What follows the "/" starting the draft, when there is a menu to read.
    private var commandQuery: String? { !blocked && commandScope != nil ? SlashCommands.query(in: draft) : nil }

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
                    Button { self.talkNote = nil } label: {
                        Image(systemName: "xmark")
                            .font(.caption.weight(.bold))
                            .frame(width: 44, height: 32)
                            .minimumTapTarget()
                    }
                    .buttonStyle(.target)
                    .accessibilityLabel("Dismiss")
                }
                .font(.footnote)
                .foregroundStyle(palette.muted)
                .padding(.leading, 16)
                .padding(.bottom, 2)
            }
            if let warning = usage?.warning {
                UsageWarningRow(warning: warning, onOpen: quick.onUsage) { model.send(.dismissUsageWarning(warning.key)) }
            }
            if let question, let onAnswer {
                QuestionPromptView(question: question, refused: returned?.answer != nil ? returned?.id : nil, onSubmit: { onAnswer(question, $0) })
                    .id("\(question.runId)|\(question.requestId)|\(question.questionId)")
                    .fitsShortScreens()
            }
            above
            if tray == nil, let commandQuery, let commandScope, model.commands(for: commandScope)?.isEmpty != true {
                CommandPicker(commands: model.commands(for: commandScope), query: commandQuery) { command in
                    draft = SlashCommands.inserting(command)
                    commandsPicked += 1
                }
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }
            if let tray {
                Group {
                    switch tray {
                    case .attach:
                        AttachTray(canShoot: UIImagePickerController.isSourceTypeAvailable(.camera), onLibrary: {
                            closeTray()
                            picking = true
                        }, onCamera: {
                            closeTray()
                            shooting = true
                        }, onClose: closeTray)
                    case .settings:
                        SettingsTray(settings: settings, catalog: model.catalog, quick: quick, usage: usage, onClose: closeTray)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.bottom, 8)
                .transition(.move(edge: .bottom).combined(with: .opacity))
            } else {
                field(summary)
            }
        }
        .padding(.top, 6)
        .composerGround(palette)
        .sensoryFeedback(.impact(weight: .light), trigger: sent)
        .sensoryFeedback(.impact(weight: .medium), trigger: heard)
        .sensoryFeedback(.selection, trigger: talkCancelling)
        .sensoryFeedback(.selection, trigger: commandsPicked)
        .animation(.snappy(duration: 0.2), value: commandQuery == nil)
        .onChange(of: commandQuery == nil ? nil : commandScope) { _, scope in
            if let scope { model.readCommands(for: scope) }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase != .active { cancelTalk() }
        }
        .onChange(of: pressing) { _, held in
            guard !held else { return }
            /// A touch the system took away, such as by an alert, never ends, so the hold is dropped.
            Task { @MainActor in
                await Task.yield()
                if !talkEnded {
                    talkTouching = false
                    cancelTalk()
                }
            }
        }
        .photosPicker(isPresented: $picking, selection: $picked, maxSelectionCount: max(1, PickedImage.limit - images.count), matching: .images)
        .onChange(of: picked) { _, items in
            guard !items.isEmpty else { return }
            picked = []
            load(items)
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
        .onChange(of: model.refilled?.id) { _, id in
            guard id != nil, let refilled = model.refilled, refilled.key == draftKey else { return }
            lastSent = nil
            draft = model.draft(for: draftKey)
            if refilled.focus { focused = true }
        }
        .onDisappear {
            if talk == .starting || talk == .listening { cancelTalk() }
        }
        .onChange(of: draft) { old, text in
            if let lastSent, Date().timeIntervalSince(lastSent.at) < 3, text.trimmingCharacters(in: .whitespacesAndNewlines) == lastSent.text {
                self.lastSent = nil
                draft = ""
                return
            }
            if focused { dictation.record(from: old, to: text) }
            model.keepDraft(text, for: draftKey)
        }
        .onChange(of: returned) { _, next in
            guard let next, let text = next.text, next.id != given else { return }
            given = next.id
            lastSent = nil
            if draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { draft = text }
        }
    }

    /// The words, the pictures going with them, and the row of controls beneath.
    private func field(_ summary: (mode: String, model: String, effort: String?)) -> some View {
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
                                            .frame(width: 44, height: 44, alignment: .topTrailing)
                                    }
                                    .buttonStyle(.target)
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
                    TalkStrip(phase: talk, levels: recorder.levels, startedAt: recorder.startedAt, cancelling: talkCancelling, handsFree: talkHandsFree, held: talkHeld, onCancel: cancelTalk)
                }
                if !blocked && !talk.active {
                    Button {
                        focused = false
                        withAnimation(.snappy) { tray = .attach }
                    } label: {
                        Image(systemName: "plus")
                            .font(.body.weight(.semibold))
                            .foregroundStyle(palette.inkDim)
                            .frame(width: 34, height: 34)
                            .background(palette.raised, in: Circle())
                            .frame(width: 44, height: 44)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.target)
                    .disabled(images.count >= PickedImage.limit)
                    .accessibilityLabel("Add pictures")
                }
                if !talk.active {
                Button {
                    focused = false
                    withAnimation(.snappy) { tray = .settings }
                } label: {
                    settingsChip(summary)
                }
                .buttonStyle(.target)
                .accessibilityLabel("Thread settings: \([summary.mode, summary.model, summary.effort, usage.map { "plan \($0.share)% used" }].compactMap { $0 }.joined(separator: ", "))")
                Spacer(minLength: 4)
                }
                if canTalk || talk.active {
                    talkButton
                }
                if talkHandsFree {
                    Button { send(onSend) } label: {
                        Image(systemName: "arrow.up")
                            .font(.body.weight(.bold))
                            .foregroundStyle(palette.contrastInk)
                            .frame(width: 34, height: 34)
                            .background(palette.contrast, in: Circle())
                            .frame(width: 44, height: 44)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.target)
                    .accessibilityLabel("Send")
                    .accessibilityHint("Adds what you said and sends the message")
                } else if talk.active {
                    /// Holds Send's place, so the microphone stays under the finger.
                    Color.clear.frame(width: 44, height: 44)
                } else if queueing {
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
                            .foregroundStyle(typed ? palette.accentInk : palette.muted)
                            .frame(width: 34, height: 34)
                            .background(typed ? palette.accent : palette.raised, in: Circle())
                            .animation(.snappy(duration: 0.2), value: typed)
                            .frame(width: 44, height: 44)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.target)
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
        .background {
            Color.clear
                .contentShape(Rectangle())
                .onTapGesture { if !blocked && !talk.active { focused = true } }
                .accessibilityHidden(true)
        }
        .composerSurface(palette, focused: focused)
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
        .transition(.opacity)
    }

    /// The summary gives up its axis names, then its values, before the run's buttons give up any room.
    private func settingsChip(_ summary: (mode: String, model: String, effort: String?)) -> some View {
        ViewThatFits(in: .horizontal) {
            settingsSummary([summary.model, summary.effort, summary.mode].compactMap { $0 })
            settingsSummary([summary.model, summary.effort].compactMap { $0 })
            settingsSummary([summary.model])
            Group {
                if let usage {
                    UsageRing(share: usage.share, size: 16)
                } else {
                    Image(systemName: "slider.horizontal.3")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(palette.inkDim)
                }
            }
            .frame(width: 34, height: 34)
            .background(palette.raised, in: Circle())
        }
        .frame(minHeight: 44)
        .contentShape(Rectangle())
    }

    /// The thread's model, effort and mode as one chip, dropping from the end when room runs out, behind the plan's ring.
    private func settingsSummary(_ values: [String]) -> some View {
        HStack(spacing: 5) {
            if let usage { UsageRing(share: usage.share).padding(.trailing, 1) }
            Text(values.joined(separator: " · ")).font(.footnote.weight(.semibold)).foregroundStyle(palette.inkDim)
            Image(systemName: "chevron.down").font(.caption2.weight(.bold)).foregroundStyle(palette.muted)
        }
        .lineLimit(1)
        .fixedSize()
        .padding(.leading, usage == nil ? 12 : 10)
        .padding(.trailing, 12)
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
        .buttonStyle(.target)
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
        .buttonStyle(.target)
        .accessibilityLabel("Stop this run")
    }

    /// The microphone: held, it listens; letting go writes what was heard into the draft for Send to
    /// send like typing, and sliding up to the mark above it cancels. A tap keeps it listening
    /// hands-free, and the next press adds the words.
    private var talkButton: some View {
        let lit = talk == .listening || talk == .starting
        let hearing = talk == .listening && !talkCancelling && !talkHandsFree
        return ZStack {
            if hearing { TalkHalo(level: recorder.levels.last ?? 0).transition(.opacity) }
            Circle()
                .fill(talkCancelling ? palette.dangerSurface : lit ? palette.accent : palette.raised)
                .overlay { if talkCancelling { Circle().strokeBorder(palette.danger.opacity(0.4), lineWidth: 1) } }
                .frame(width: 34, height: 34)
                .scaleEffect(hearing ? 1.12 : 1)
            if talk == .transcribing {
                ProgressView().tint(palette.inkDim)
            } else {
                Image(systemName: talkCancelling ? "xmark" : talkHandsFree ? "checkmark" : "mic.fill")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(talkCancelling ? palette.danger : lit ? palette.accentInk : palette.inkDim)
                    .contentTransition(.symbolEffect(.replace))
            }
        }
        .animation(.snappy(duration: 0.2), value: talk)
        .animation(.snappy(duration: 0.2), value: talkHandsFree)
        .frame(width: 44, height: 44)
        .contentShape(Rectangle())
        .overlay(alignment: .top) {
            if talk == .listening && talkHeld && !talkHandsFree {
                TalkCancelTarget(armed: talkCancelling)
                    .offset(y: -TalkPhase.cancelDistance - 18)
                    .transition(.opacity.combined(with: .move(edge: .bottom)))
            }
        }
        .zIndex(1)
        .gesture(
            DragGesture(minimumDistance: 0)
                .updating($pressing) { _, state, _ in state = true }
                .onChanged { value in pressMoved(value.translation.height, at: value.time) }
                .onEnded { value in pressEnded(value.translation.height, at: value.time) }
        )
        .disabled(talk == .transcribing)
        .accessibilityElement()
        .accessibilityLabel(talkHandsFree ? "Add the words" : "Dictate")
        .accessibilityHint(talkHandsFree ? "Adds what you said to your message" : "Hold, speak, and let go to add the words to your message, or tap to talk hands-free")
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { talkHandsFree ? finishHandsFree() : tapToTalk() }
    }

    /// `at` is when the touch happened, so a tap reads as one however long the main thread took to hear it.
    private func pressMoved(_ rise: CGFloat, at time: Date) {
        if !talkTouching {
            talkTouching = true
            talkEnded = false
            if talkHandsFree { return finishHandsFree() }
            guard talk == .idle else { return }
            talkReleased = false
            talkCancelling = false
            talkHeld = false
            pressedAt = time
            startTalking()
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(TalkPhase.tapSeconds))
                if talkTouching, !talkHandsFree, talk == .starting || talk == .listening {
                    withAnimation(.snappy(duration: 0.2)) { talkHeld = true }
                }
            }
            return
        }
        guard !talkHandsFree, talk == .starting || talk == .listening else { return }
        let cancelling = rise < -TalkPhase.cancelDistance
        if cancelling != talkCancelling { talkCancelling = cancelling }
    }

    private func pressEnded(_ rise: CGFloat, at time: Date) {
        talkEnded = true
        talkTouching = false
        guard !talkHandsFree, talk == .starting || talk == .listening else { return }
        if rise < -TalkPhase.cancelDistance { return cancelTalk() }
        if time.timeIntervalSince(pressedAt) < TalkPhase.tapSeconds {
            unanimated {
                talkCancelling = false
                talkHandsFree = true
            }
            return
        }
        if talk == .starting { talkReleased = true } else { finishTalking() }
    }

    /// VoiceOver's activation: one action starts hands-free listening.
    private func tapToTalk() {
        guard talk == .idle else { return }
        talkReleased = false
        talkCancelling = false
        startTalking()
        if talk == .starting { unanimated { talkHandsFree = true } }
    }

    /// The press that ends hands-free listening, adding the words. Then sends them too when given how.
    private func finishHandsFree(then how: ((String, [String]) -> Void)? = nil) {
        unanimated {
            talkHandsFree = false
            if talk == .starting { talkReleased = true } else if talk == .listening { finishTalking(then: how) }
        }
    }

    /// The microphone lights, and the hands-free checkmark comes and goes, without animating.
    private func unanimated(_ body: () -> Void) {
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction, body)
    }

    private func startTalking() {
        talkNote = nil
        /// The first hold only asks, since the alert takes the finger; the next hold listens.
        guard AVAudioApplication.shared.recordPermission != .undetermined else {
            Task { @MainActor in
                if await AVAudioApplication.requestRecordPermission() { talkNote = "Now hold to talk, or tap for hands-free." }
            }
            return
        }
        unanimated { talk = .starting }
        Dictation.finish()
        Task { @MainActor in
            do {
                try await recorder.start()
            } catch {
                talk = .idle
                talkNote = error.localizedDescription
                return
            }
            guard talk == .starting else { return recorder.cancel() }
            talk = .listening
            heard += 1
            if talkReleased { talkCancelling ? cancelTalk() : finishTalking() }
        }
    }

    private func cancelTalk() {
        if talkHandsFree { return unanimated { talkHandsFree = false; cancelTalk() } }
        guard talk.active else { return }
        if talk == .listening { recorder.cancel() }
        talk = .idle
        talkCancelling = false
    }

    /// The computer writes down what was heard, and the words follow whatever was typed, to be sent with
    /// it. They are kept with the draft the hold began on, even if its thread is left before they arrive;
    /// `how` sends them once they land in the draft still on screen.
    private func finishTalking(then how: ((String, [String]) -> Void)? = nil) {
        talkCancelling = false
        talkHandsFree = false
        guard let wav = recorder.stop() else { talk = .idle; return }
        talk = .transcribing
        let key = draftKey
        Task { @MainActor in
            defer { talk = .idle }
            do {
                let words = try await model.transcribe(wav).trimmingCharacters(in: .whitespacesAndNewlines)
                guard !words.isEmpty else {
                    talkNote = "Didn't catch anything."
                    return
                }
                model.addSpokenWords(words, to: key)
                guard let how, key == draftKey else { return }
                draft = model.draft(for: key)
                commit(how)
            } catch {
                talkNote = error.localizedDescription
            }
        }
    }

    /// Sends what is typed. Dictation still running stops first, and its last words go with the message.
    private func send(_ how: @escaping (String, [String]) -> Void) {
        if talkHandsFree { return finishHandsFree(then: how) }
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

    private func closeTray() {
        withAnimation(.snappy) { tray = nil }
    }

    private func load(_ items: [PhotosPickerItem]) {
        Task {
            for item in items {
                guard images.count < PickedImage.limit, let data = try? await item.loadTransferable(type: Data.self), let image = await PickedImage.make(from: data) else { continue }
                images.append(image)
            }
        }
    }

    private func commit(_ how: (String, [String]) -> Void) {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        let sources = images.map(\.source)
        guard !text.isEmpty || !sources.isEmpty else { return }
        draft = ""
        model.keepDraft("", for: draftKey)
        lastSent = text.isEmpty ? nil : (text, Date())
        images = []
        dictation.reset()
        sent += 1
        how(text, sources)
    }
}

extension ComposerView where Above == EmptyView {
    init(model: PhoneModel, draftKey: String, running: Bool, settings: MobileThreadSettings, question: PendingQuestion?, returned: ComposerReturned?, onSend: @escaping (String, [String]) -> Void, onSteer: ((String, [String]) -> Void)?, onStop: (() -> Void)?, onAnswer: ((PendingQuestion, String) -> Void)?, quick: QuickSettings, commandScope: PhoneModel.CommandScope?) {
        self.init(model: model, draftKey: draftKey, running: running, settings: settings, question: question, returned: returned, onSend: onSend, onSteer: onSteer, onStop: onStop, onAnswer: onAnswer, quick: quick, commandScope: commandScope) { EmptyView() }
    }
}

/// What the settings tray changes.
struct QuickSettings {
    /// A thread keeps its engine; a draft may pick any.
    var locked: Bool
    var onPolicy: (String) -> Void
    var onModel: (String, String) -> Void
    var onEffort: (String, String) -> Void
    var onFastMode: (Bool) -> Void
    /// Opens the plan's limits.
    var onUsage: (() -> Void)? = nil
}

enum ComposerTray {
    case attach, settings
}

/// A tray's card: a grabber over its content. A tap on the grabber or a swipe down closes it; the card follows the finger and leaves from where it was let go.
struct TrayFrame<Content: View>: View {
    var onClose: () -> Void
    @ViewBuilder var content: Content
    @Environment(\.palette) private var palette
    @State private var drag: CGFloat = 0

    var body: some View {
        VStack(spacing: 0) {
            Capsule()
                .fill(palette.lineStrong)
                .frame(width: 36, height: 5)
                .frame(maxWidth: .infinity, minHeight: 22)
                .contentShape(Rectangle())
                .onTapGesture(perform: onClose)
                .accessibilityLabel("Close")
                .accessibilityAddTraits(.isButton)
            content.padding(.bottom, 6)
        }
        .composerSurface(palette, focused: true)
        .offset(y: drag)
        .gesture(
            DragGesture(minimumDistance: 8)
                .onChanged { value in drag = max(0, value.translation.height) }
                .onEnded { value in
                    if value.translation.height > 60 || value.predictedEndTranslation.height > 160 {
                        onClose()
                    } else {
                        withAnimation(.snappy) { drag = 0 }
                    }
                }
        )
    }
}

/// Where pictures come from: the photo library, or the camera.
struct AttachTray: View {
    var canShoot: Bool
    var onLibrary: () -> Void
    var onCamera: () -> Void
    var onClose: () -> Void
    @Environment(\.palette) private var palette

    var body: some View {
        TrayFrame(onClose: onClose) {
            VStack(spacing: 0) {
                row("Photo Library", symbol: "photo.on.rectangle", action: onLibrary)
                if canShoot {
                    palette.line.frame(height: 0.5).padding(.leading, 48)
                    row("Take Photo", symbol: "camera", action: onCamera)
                }
            }
        }
    }

    private func row(_ title: String, symbol: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label {
                Text(title).font(.body).foregroundStyle(palette.ink)
            } icon: {
                Image(systemName: symbol).foregroundStyle(palette.inkDim).frame(width: 22)
            }
            .frame(maxWidth: .infinity, minHeight: 50, alignment: .leading)
            .padding(.horizontal, 14)
            .contentShape(Rectangle())
        }
        .buttonStyle(.target)
    }
}

/// Stands in for the composer while the thread's settings change; each pick applies at once.
struct SettingsTray: View {
    var settings: MobileThreadSettings
    var catalog: EngineCatalog
    var quick: QuickSettings
    var usage: MobileComposerUsage?
    var onClose: () -> Void
    @Environment(\.palette) private var palette
    @State private var page: Page?

    private enum Page {
        case effort, mode
    }

    /// One choice on a page: its name, what it means, and its id.
    private struct Choice: Identifiable {
        var id: String
        var label: String
        var detail: String?
    }

    var body: some View {
        TrayFrame(onClose: onClose) {
            ZStack(alignment: .top) {
                switch page {
                case nil:
                    home.transition(.move(edge: .leading).combined(with: .opacity))
                case .effort:
                    let efforts = self.efforts
                    choices("Effort", efforts.map { Choice(id: $0.id, label: $0.label, detail: $0.description) }, selected: chosenEffort) { quick.onEffort(settings.engine, $0) }
                        .transition(.move(edge: .trailing).combined(with: .opacity))
                case .mode:
                    choices("Mode", catalog.policies(settings.engine).map { Choice(id: $0.id, label: $0.label, detail: $0.description) }, selected: settings.policy) { quick.onPolicy($0) }
                        .transition(.move(edge: .trailing).combined(with: .opacity))
                }
            }
            .clipped()
        }
    }

    private var known: Bool { catalog.knows(settings.engine) }

    private var efforts: [MobileEffortTerm] {
        guard known, let model = settings.model else { return [] }
        return catalog.efforts(settings.engine, model: model, coordinating: settings.coordinating == true)
    }

    private var chosenEffort: String? {
        settings.model.map { catalog.effortForModel(settings.engine, model: $0, effort: settings.effort, coordinating: settings.coordinating == true) }
    }

    private var home: some View {
        let headings = catalog.library(engine: settings.engine, locked: quick.locked).filter { !$0.locked && !$0.models.isEmpty }
        let efforts = self.efforts
        return VStack(spacing: 0) {
            if headings.reduce(0, { $0 + $1.models.count }) > 6 {
                ScrollView { models(headings) }.frame(height: 360)
            } else {
                models(headings)
            }
            palette.line.frame(height: 0.5).padding(.horizontal, 14)
            if !efforts.isEmpty, let chosenEffort {
                link("Effort", symbol: "gauge.with.dots.needle.50percent", value: efforts.first { $0.id == chosenEffort }?.label ?? chosenEffort, to: .effort)
            }
            if known {
                if !efforts.isEmpty { divider }
                link("Mode", symbol: "hand.raised", value: catalog.policyLabel(settings.policy), to: .mode)
            }
            if catalog.fastMode(settings.engine) {
                divider
                Toggle(isOn: Binding(get: { settings.fastMode == true }, set: quick.onFastMode)) {
                    rowLabel("Fast Mode", symbol: "hare")
                }
                .padding(.horizontal, 14)
                .frame(minHeight: 50)
            }
            if let usage, let onUsage = quick.onUsage {
                divider
                Button(action: onUsage) {
                    HStack(spacing: 8) {
                        rowLabel("Usage", symbol: usage.symbol)
                        Spacer(minLength: 8)
                        Text(usage.summary).font(.subheadline).foregroundStyle(palette.muted).lineLimit(1)
                        Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(palette.quiet)
                    }
                    .padding(.horizontal, 14)
                    .frame(minHeight: 50)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.target)
            }
        }
    }

    private var divider: some View {
        palette.line.frame(height: 0.5).padding(.leading, 48)
    }

    private func rowLabel(_ title: String, symbol: String) -> some View {
        Label {
            Text(title).font(.body).foregroundStyle(palette.ink)
        } icon: {
            Image(systemName: symbol).foregroundStyle(palette.inkDim).frame(width: 22)
        }
    }

    /// A setting's name and value, opening its choices on a page of their own.
    private func link(_ title: String, symbol: String, value: String, to target: Page) -> some View {
        Button {
            withAnimation(.snappy) { page = target }
        } label: {
            HStack(spacing: 8) {
                rowLabel(title, symbol: symbol)
                Spacer(minLength: 8)
                Text(value).font(.body).foregroundStyle(palette.muted).lineLimit(1)
                Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(palette.quiet)
            }
            .padding(.horizontal, 14)
            .frame(minHeight: 50)
            .contentShape(Rectangle())
        }
        .buttonStyle(.target)
        .accessibilityLabel("\(title), \(value)")
    }

    /// One setting's choices; a pick applies and goes back.
    private func choices(_ title: String, _ items: [Choice], selected: String?, pick: @escaping (String) -> Void) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            ZStack {
                Text(title).font(.headline).foregroundStyle(palette.ink)
                HStack {
                    Button {
                        withAnimation(.snappy) { page = nil }
                    } label: {
                        Image(systemName: "chevron.left")
                            .font(.body.weight(.semibold))
                            .foregroundStyle(palette.inkDim)
                            .frame(width: 44, height: 44)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.target)
                    .accessibilityLabel("Back")
                    Spacer()
                }
            }
            .padding(.horizontal, 4)
            ForEach(items) { item in
                option(item.label, detail: item.detail, selected: item.id == selected) {
                    pick(item.id)
                    withAnimation(.snappy) { page = nil }
                }
            }
        }
    }

    /// A row naming one choice and what it is for, checked when chosen.
    private func option(_ label: String, detail: String?, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(label).font(.body.weight(.medium)).foregroundStyle(palette.ink)
                    if let detail, !detail.isEmpty {
                        Text(detail).font(.footnote).foregroundStyle(palette.muted).lineLimit(2)
                    }
                }
                Spacer(minLength: 8)
                Image(systemName: "checkmark")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(palette.accent)
                    .opacity(selected ? 1 : 0)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 9)
            .frame(minHeight: 50)
            .contentShape(Rectangle())
        }
        .buttonStyle(.target)
        .accessibilityAddTraits(selected ? [.isSelected] : [])
    }

    /// The models to choose from, each with what it is for; one tap picks it.
    private func models(_ headings: [ModelHeading]) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(headings, id: \.key) { heading in
                if headings.count > 1 {
                    SectionLabel(heading.label).padding(.horizontal, 14).padding(.top, 8).padding(.bottom, 2)
                }
                ForEach(heading.models, id: \.id) { spec in
                    option(spec.label, detail: spec.description, selected: heading.engine == settings.engine && spec.id == settings.model) {
                        quick.onModel(heading.engine, spec.id)
                    }
                }
            }
        }
        .padding(.bottom, 4)
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
                        .buttonStyle(.target)
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
            .buttonStyle(.target)
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
