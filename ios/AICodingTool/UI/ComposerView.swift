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
    @ViewBuilder var above: Above

    @Environment(\.palette) private var palette
    @State private var draft = ""
    @State private var given: String?
    @State private var seenHandBack: UUID?
    @State private var images: [PickedImage] = []
    @State private var picking = false
    @State private var shooting = false
    @State private var picked: [PhotosPickerItem] = []
    @FocusState private var focused: Bool

    private var blocked: Bool { question?.blocking == true }
    private var typed: Bool { !blocked && (!draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !images.isEmpty) }
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
                }
                HStack(spacing: 8) {
                    if !blocked {
                        Menu {
                            Button { picking = true } label: { Label("Photo Library", systemImage: "photo.on.rectangle") }
                            if UIImagePickerController.isSourceTypeAvailable(.camera) {
                                Button { shooting = true } label: { Label("Take Photo", systemImage: "camera") }
                            }
                        } label: {
                            Image(systemName: "photo.badge.plus")
                                .font(.body)
                                .foregroundStyle(palette.inkDim)
                                .frame(width: 30, height: 34)
                                .contentShape(Rectangle())
                        }
                        .disabled(images.count >= PickedImage.limit)
                        .accessibilityLabel("Add pictures")
                    }
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

    private func send(_ how: (String, [String]) -> Void) {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        let sources = images.map(\.source)
        guard !text.isEmpty || !sources.isEmpty else { return }
        draft = ""
        images = []
        how(text, sources)
    }
}

extension ComposerView where Above == EmptyView {
    init(model: PhoneModel, draftKey: String, running: Bool, settings: MobileThreadSettings, question: PendingQuestion?, returned: ComposerReturned?, onSend: @escaping (String, [String]) -> Void, onSteer: ((String, [String]) -> Void)?, onStop: (() -> Void)?, onAnswer: ((PendingQuestion, String) -> Void)?, onSettings: @escaping () -> Void) {
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
