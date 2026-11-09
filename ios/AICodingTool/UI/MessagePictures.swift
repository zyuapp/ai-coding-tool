import Markdown
import SwiftUI
import UIKit

/// An image a reply links or embeds: the destination as written, and what the reply calls it.
struct MessagePicture: Hashable, Sendable {
    var href: String
    var label: String

    static let limit = 20

    /// The local images a reply links, in order, as the desktop previews them. The computer decides whether each is one it will read.
    static func find(in text: String) -> [MessagePicture] {
        guard text.range(of: #"\.(?:png|jpe?g|gif|webp)\b"#, options: [.regularExpression, .caseInsensitive]) != nil else { return [] }
        var finder = Finder()
        finder.visit(Document(parsing: text))
        return finder.found
    }

    /// A path or `file:` URL ending in a raster image's extension. Web links stay links.
    static func isLocalImage(_ destination: String) -> Bool {
        if let scheme = destination.range(of: #"^[A-Za-z][A-Za-z\d+.-]*:"#, options: .regularExpression), destination[scheme].lowercased() != "file:" { return false }
        let path = destination.removingPercentEncoding ?? destination
        return path.range(of: #"\.(?:png|jpe?g|gif|webp)$"#, options: [.regularExpression, .caseInsensitive]) != nil
    }

    private struct Finder: MarkupWalker {
        var found: [MessagePicture] = []

        mutating func visitLink(_ link: Markdown.Link) {
            add(link.destination, link.plainText)
            descendInto(link)
        }

        mutating func visitImage(_ image: Markdown.Image) {
            add(image.source, image.plainText)
            descendInto(image)
        }

        private mutating func add(_ destination: String?, _ label: String) {
            guard found.count < MessagePicture.limit, let destination, MessagePicture.isLocalImage(destination), !found.contains(where: { $0.href == destination }) else { return }
            found.append(MessagePicture(href: destination, label: label.isEmpty ? "Screenshot" : label))
        }
    }
}

/// Images read from the computer, kept while memory allows. A few reads run at once, leaving the line free for the rest.
@MainActor
final class PictureStore {
    struct Key: Hashable {
        var taskId: String
        var messageId: String
        var href: String
        var preview: Bool
    }

    private struct Unreadable: LocalizedError {
        var errorDescription: String? { "This image could not be read." }
    }

    private static let concurrent = 3
    private let cache = NSCache<NSString, UIImage>()
    private var running: [Key: Task<UIImage, Error>] = [:]
    private var active = 0
    private var waiting: [CheckedContinuation<Void, Never>] = []

    init() {
        cache.totalCostLimit = 128 * 1024 * 1024
    }

    func cached(_ key: Key) -> UIImage? {
        cache.object(forKey: Self.name(key))
    }

    func image(_ key: Key, from connection: PhoneConnection) async throws -> UIImage {
        if let image = cached(key) { return image }
        if let task = running[key] { return try await task.value }
        let task = Task { () throws -> UIImage in
            await self.take()
            defer { self.give() }
            struct Read: Decodable { var data: String }
            let read = try await connection.query(.image(taskId: key.taskId, messageId: key.messageId, href: key.href, preview: key.preview)).decode(Read.self)
            guard let data = Data(base64Encoded: read.data) else { throw Unreadable() }
            let image = try await Task.detached(priority: .userInitiated) { () throws -> UIImage in
                guard let image = UIImage(data: data) else { throw Unreadable() }
                return await image.byPreparingForDisplay() ?? image
            }.value
            let pixels = image.size.width * image.scale * image.size.height * image.scale
            self.cache.setObject(image, forKey: Self.name(key), cost: Int(pixels) * 4)
            return image
        }
        running[key] = task
        defer { running[key] = nil }
        return try await task.value
    }

    private func take() async {
        if active < Self.concurrent {
            active += 1
            return
        }
        await withCheckedContinuation { waiting.append($0) }
    }

    /// A waiting read inherits the slot rather than racing for it.
    private func give() {
        if waiting.isEmpty { active -= 1 } else { waiting.removeFirst().resume() }
    }

    private static func name(_ key: Key) -> NSString {
        "\(key.taskId)\n\(key.messageId)\n\(key.preview ? 1 : 0)\n\(key.href)" as NSString
    }
}

/// Where a transcript's images are read from: its thread, on the paired computer.
@MainActor
struct PictureSource {
    var taskId: String
    var store: PictureStore
    var connection: PhoneConnection

    func key(_ messageId: String, _ picture: MessagePicture, preview: Bool) -> PictureStore.Key {
        PictureStore.Key(taskId: taskId, messageId: messageId, href: picture.href, preview: preview)
    }

    var live: Bool { connection.state.connection == .live }
}

private struct PictureSourceKey: EnvironmentKey {
    static let defaultValue: PictureSource? = nil
}

extension EnvironmentValues {
    var pictureSource: PictureSource? {
        get { self[PictureSourceKey.self] }
        set { self[PictureSourceKey.self] = newValue }
    }
}

/// A reply's images as a strip of previews under it. Tapping one opens it full screen, where a swipe steps through the rest.
struct MessagePicturesView: View {
    var messageId: String
    var text: String
    @Environment(\.pictureSource) private var source
    @Namespace private var zoom
    @State private var opened: Int?

    var body: some View {
        let pictures = MessagePicture.find(in: text)
        if let source, !pictures.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 10) {
                    ForEach(Array(pictures.enumerated()), id: \.offset) { index, picture in
                        PictureTile(source: source, messageId: messageId, picture: picture) { opened = index }
                            .matchedTransitionSource(id: index, in: zoom)
                    }
                }
            }
            .scrollClipDisabled()
            .padding(.top, 4)
            .fullScreenCover(isPresented: Binding(get: { opened != nil }, set: { if !$0 { opened = nil } })) {
                PictureViewer(source: source, messageId: messageId, pictures: pictures, index: Binding(get: { opened ?? 0 }, set: { opened = $0 }))
                    .navigationTransition(.zoom(sourceID: opened ?? 0, in: zoom))
            }
        }
    }
}

private struct PictureTile: View {
    var source: PictureSource
    var messageId: String
    var picture: MessagePicture
    var open: () -> Void
    @Environment(\.palette) private var palette
    @State private var image: UIImage?
    @State private var failed = false

    private struct Attempt: Equatable {
        var key: PictureStore.Key
        var live: Bool
    }

    var body: some View {
        let key = source.key(messageId, picture, preview: true)
        Group {
            if failed {
                Label("\(picture.label) · Preview unavailable", systemImage: "photo")
                    .font(.footnote)
                    .foregroundStyle(palette.muted)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 9)
                    .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(palette.line))
            } else {
                Button(action: open) {
                    ZStack {
                        palette.sunken
                        if let image {
                            SwiftUI.Image(uiImage: image).resizable().scaledToFit()
                        } else {
                            ProgressView().controlSize(.small)
                        }
                    }
                    .frame(width: 256, height: 144)
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(palette.line))
                    .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Enlarge \(picture.label)")
            }
        }
        .task(id: Attempt(key: key, live: source.live)) {
            if let held = source.store.cached(key) {
                image = held
                failed = false
                return
            }
            guard source.live else { return }
            do {
                image = try await source.store.image(key, from: source.connection)
                failed = false
            } catch is CancellationError {
            } catch {
                failed = image == nil
            }
        }
    }
}

/// A reply's images full screen, one page each: pinch or double-tap to zoom, swipe to step, share to save.
private struct PictureViewer: View {
    var source: PictureSource
    var messageId: String
    var pictures: [MessagePicture]
    @Binding var index: Int
    @Environment(\.dismiss) private var dismiss
    @State private var originals: [Int: UIImage] = [:]

    var body: some View {
        TabView(selection: $index) {
            ForEach(Array(pictures.enumerated()), id: \.offset) { offset, picture in
                PicturePage(source: source, messageId: messageId, picture: picture) { originals[offset] = $0 }
                    .tag(offset)
            }
        }
        .tabViewStyle(.page(indexDisplayMode: .never))
        .background(Color.black)
        .ignoresSafeArea()
        .overlay(alignment: .top) { bar }
        .statusBarHidden()
        .preferredColorScheme(.dark)
    }

    private var bar: some View {
        HStack {
            Button { dismiss() } label: {
                SwiftUI.Image(systemName: "xmark")
                    .font(.body.weight(.semibold))
                    .frame(width: 44, height: 44)
                    .background(.ultraThinMaterial, in: Circle())
            }
            .accessibilityLabel("Close")
            Spacer(minLength: 0)
            if let original = originals[index], index < pictures.count {
                let label = pictures[index].label
                ShareLink(item: SwiftUI.Image(uiImage: original), preview: SharePreview(label, image: SwiftUI.Image(uiImage: original))) {
                    SwiftUI.Image(systemName: "square.and.arrow.up")
                        .font(.body.weight(.semibold))
                        .frame(width: 44, height: 44)
                        .background(.ultraThinMaterial, in: Circle())
                }
                .accessibilityLabel("Share image")
            }
        }
        .overlay {
            if pictures.count > 1 {
                Text("\(index + 1) / \(pictures.count)")
                    .font(.subheadline.weight(.semibold).monospacedDigit())
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .background(.ultraThinMaterial, in: Capsule())
                    .accessibilityLabel("Image \(index + 1) of \(pictures.count)")
            }
        }
        .foregroundStyle(.white)
        .padding(.horizontal, 16)
        .padding(.top, 8)
    }
}

/// One image: its preview at once if held, then the original.
private struct PicturePage: View {
    var source: PictureSource
    var messageId: String
    var picture: MessagePicture
    var onOriginal: (UIImage) -> Void
    @State private var image: UIImage?
    @State private var loading = true
    @State private var failed = false

    private struct Attempt: Equatable {
        var key: PictureStore.Key
        var live: Bool
    }

    var body: some View {
        let key = source.key(messageId, picture, preview: false)
        ZStack {
            if let image {
                ZoomableImage(image: image).ignoresSafeArea()
            }
            if failed {
                Text("This image is no longer available.").font(.subheadline).foregroundStyle(.white.opacity(0.7))
            } else if loading {
                ProgressView().tint(.white)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(picture.label)
        .accessibilityAddTraits(.isImage)
        .task(id: Attempt(key: key, live: source.live)) {
            if let held = source.store.cached(key) {
                show(held)
                return
            }
            if image == nil { image = source.store.cached(source.key(messageId, picture, preview: true)) }
            guard source.live else { return }
            do {
                show(try await source.store.image(key, from: source.connection))
            } catch is CancellationError {
            } catch {
                loading = false
                failed = image == nil
            }
        }
    }

    private func show(_ original: UIImage) {
        image = original
        loading = false
        failed = false
        onOriginal(original)
    }
}

private struct ZoomableImage: UIViewRepresentable {
    var image: UIImage

    func makeUIView(context: Context) -> ZoomingImageView { ZoomingImageView() }

    func updateUIView(_ view: ZoomingImageView, context: Context) { view.show(image) }
}

/// An image fitted to the screen and centred, zoomed by pinching or double-tapping where to look.
final class ZoomingImageView: UIScrollView, UIScrollViewDelegate {
    private let imageView = UIImageView()
    private var fittedTo: CGSize = .zero

    override init(frame: CGRect) {
        super.init(frame: frame)
        delegate = self
        showsHorizontalScrollIndicator = false
        showsVerticalScrollIndicator = false
        decelerationRate = .fast
        contentInsetAdjustmentBehavior = .never
        backgroundColor = .clear
        addSubview(imageView)
        let doubleTap = UITapGestureRecognizer(target: self, action: #selector(toggleZoom(_:)))
        doubleTap.numberOfTapsRequired = 2
        addGestureRecognizer(doubleTap)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    func show(_ image: UIImage) {
        guard imageView.image !== image else { return }
        imageView.image = image
        fit()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        if bounds.size != fittedTo { fit() }
    }

    private func fit() {
        guard let image = imageView.image, image.size.width > 0, image.size.height > 0, bounds.width > 0, bounds.height > 0 else { return }
        fittedTo = bounds.size
        minimumZoomScale = 1
        zoomScale = 1
        let scale = min(bounds.width / image.size.width, bounds.height / image.size.height)
        let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
        imageView.frame = CGRect(origin: .zero, size: size)
        contentSize = size
        maximumZoomScale = max(4, 2 / scale)
        centre()
    }

    private func centre() {
        let inset = UIEdgeInsets(top: max(0, (bounds.height - contentSize.height) / 2), left: max(0, (bounds.width - contentSize.width) / 2),
                                 bottom: max(0, (bounds.height - contentSize.height) / 2), right: max(0, (bounds.width - contentSize.width) / 2))
        if contentInset != inset { contentInset = inset }
    }

    func viewForZooming(in scrollView: UIScrollView) -> UIView? { imageView }

    func scrollViewDidZoom(_ scrollView: UIScrollView) { centre() }

    @objc private func toggleZoom(_ tap: UITapGestureRecognizer) {
        if zoomScale > minimumZoomScale {
            setZoomScale(minimumZoomScale, animated: true)
            return
        }
        let point = tap.location(in: imageView)
        let scale = min(maximumZoomScale, 2.5)
        let size = CGSize(width: bounds.width / scale, height: bounds.height / scale)
        zoom(to: CGRect(x: point.x - size.width / 2, y: point.y - size.height / 2, width: size.width, height: size.height), animated: true)
    }
}
