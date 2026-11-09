import SwiftUI
import UIKit
import WebKit

/// A diagram Mermaid drew: its SVG at its own size, and a picture of it for the transcript.
final class MermaidDiagram {
    let markup: String
    let size: CGSize
    let image: UIImage

    init(markup: String, size: CGSize, image: UIImage) {
        self.markup = markup
        self.size = size
        self.image = image
    }
}

enum MermaidResult {
    case drawn(MermaidDiagram)
    case failed(String)
}

/// Draws Mermaid sources in one hidden web page holding the bundled library, one at a time, and
/// remembers what each source drew as in each scheme.
@MainActor
final class MermaidRenderer: NSObject, WKNavigationDelegate {
    static let shared = MermaidRenderer()

    private final class Entry {
        let result: MermaidResult
        init(_ result: MermaidResult) { self.result = result }
    }

    private let cache: NSCache<NSString, Entry> = {
        let cache = NSCache<NSString, Entry>()
        cache.totalCostLimit = 96 * 1024 * 1024
        return cache
    }()
    private var running: [String: Task<MermaidResult, Never>] = [:]
    private var tail: Task<Void, Never>?
    private var page: Task<WKWebView?, Never>?
    private var loaded: CheckedContinuation<Void, Never>?

    /// The width a diagram is laid out in, for the few kinds that size themselves from their container.
    private static let room = 720
    /// The picture's resolution, capped so a large diagram stays within what a canvas can hold.
    private static let maxScale = 3.0
    private static let maxPixels = 12_000_000.0

    func cached(_ source: String, dark: Bool) -> MermaidResult? {
        cache.object(forKey: Self.key(source, dark: dark))?.result
    }

    func draw(_ source: String, dark: Bool) async -> MermaidResult {
        let key = Self.key(source, dark: dark)
        if let entry = cache.object(forKey: key) { return entry.result }
        if let task = running[key as String] { return await task.value }
        let previous = tail
        let task = Task { @MainActor in
            await previous?.value
            let result = await self.render(source, dark: dark)
            let cost: Int
            if case .drawn(let diagram) = result, let cg = diagram.image.cgImage { cost = cg.bytesPerRow * cg.height } else { cost = 1 }
            self.cache.setObject(Entry(result), forKey: key, cost: cost)
            self.running[key as String] = nil
            return result
        }
        running[key as String] = task
        tail = Task { _ = await task.value }
        return await task.value
    }

    private static func key(_ source: String, dark: Bool) -> NSString {
        "\(dark ? "d" : "l")\n\(source)" as NSString
    }

    private func render(_ source: String, dark: Bool) async -> MermaidResult {
        guard let web = await webView() else { return .failed("The diagram library is missing from this build.") }
        let arguments: [String: Any] = [
            "source": source,
            "theme": dark ? "dark" : "default",
            "room": Self.room,
            "maxScale": Double(UIScreen.main.scale).clamped(to: 2...Self.maxScale),
            "maxPixels": Self.maxPixels,
        ]
        /// The Objective-C entry point: the Swift overloads live in a library iOS 18 does not ship.
        let output: (value: Any?, error: Error?) = await withCheckedContinuation { continuation in
            web.__callAsyncJavaScript(Self.drawScript, arguments: arguments, inFrame: nil, in: .page) { value, error in
                continuation.resume(returning: (value, error))
            }
        }
        if let error = output.error {
            return .failed((error as NSError).userInfo["WKJavaScriptExceptionMessage"] as? String ?? error.localizedDescription)
        }
        guard let fields = output.value as? [String: Any] else { return .failed("The diagram could not be drawn.") }
        if let message = fields["error"] as? String { return .failed(message) }
        guard let markup = fields["markup"] as? String,
              let width = (fields["width"] as? NSNumber)?.doubleValue, let height = (fields["height"] as? NSNumber)?.doubleValue,
              let scale = (fields["scale"] as? NSNumber)?.doubleValue,
              let png = fields["png"] as? String, let comma = png.firstIndex(of: ","),
              let data = Data(base64Encoded: String(png[png.index(after: comma)...])),
              let image = UIImage(data: data, scale: scale)
        else { return .failed("The diagram could not be drawn.") }
        return .drawn(MermaidDiagram(markup: markup, size: CGSize(width: width, height: height), image: image))
    }

    private func webView() async -> WKWebView? {
        if let page { return await page.value }
        let task = Task { @MainActor () -> WKWebView? in
            guard let script = await Task.detached(operation: { Self.library() }).value else { return nil }
            let configuration = WKWebViewConfiguration()
            configuration.websiteDataStore = .nonPersistent()
            configuration.userContentController.addUserScript(WKUserScript(source: script, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
            let web = WKWebView(frame: CGRect(x: 0, y: 0, width: 800, height: 800), configuration: configuration)
            web.navigationDelegate = self
            await withCheckedContinuation { continuation in
                self.loaded = continuation
                web.loadHTMLString(#"<!doctype html><html><head><meta charset="utf-8"></head><body><div id="scratch"></div></body></html>"#, baseURL: nil)
            }
            return web
        }
        page = task
        return await task.value
    }

    nonisolated private static func library() -> String? {
        guard let url = Bundle.main.url(forResource: "mermaid.min", withExtension: "js") else { return nil }
        return try? String(contentsOf: url, encoding: .utf8)
    }

    nonisolated func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        Task { @MainActor in self.finishLoading() }
    }

    nonisolated func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        Task { @MainActor in self.finishLoading() }
    }

    private func finishLoading() {
        loaded?.resume()
        loaded = nil
    }

    /// Draws `source` with the desktop's settings, sizes it by its own frame rather than its container,
    /// and paints it onto a canvas for the picture.
    private static let drawScript = #"""
    if (typeof mermaid === "undefined") return { error: "The diagram library did not load." };
    mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme,
        layout: "dagre",
        htmlLabels: false,
        fontFamily: "-apple-system, system-ui, sans-serif",
        fontSize: 16,
        themeVariables: { fontSize: "16px" },
    });
    const scratch = document.getElementById("scratch");
    scratch.setAttribute("style", `position: absolute; left: -100000px; top: 0; width: ${room}px; visibility: hidden`);
    window.drawn = (window.drawn || 0) + 1;
    const id = `mermaid-${window.drawn}`;
    let svg;
    try {
        svg = (await mermaid.render(id, source, scratch)).svg;
    } catch (error) {
        return { error: error && error.message ? error.message : String(error) };
    } finally {
        scratch.replaceChildren();
        document.getElementById(`d${id}`)?.remove();
    }
    const parsed = new DOMParser().parseFromString(svg, "text/html").querySelector("svg");
    if (!parsed) return { error: "The diagram could not be drawn." };
    const element = document.importNode(parsed, true);
    element.removeAttribute("width");
    element.removeAttribute("height");
    element.style.removeProperty("max-width");
    let [x, y, width, height] = (element.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(Number);
    if (![x, y, width, height].every(Number.isFinite) || !(width > 0) || !(height > 0)) {
        scratch.appendChild(element);
        const box = element.getBBox();
        scratch.replaceChildren();
        if (!(box.width > 0 && box.height > 0)) return { error: "The diagram is empty." };
        [x, y, width, height] = [box.x - 8, box.y - 8, box.width + 16, box.height + 16];
        element.setAttribute("viewBox", `${x} ${y} ${width} ${height}`);
    }
    element.setAttribute("width", width);
    element.setAttribute("height", height);
    const markup = new XMLSerializer().serializeToString(element);
    const scale = Math.min(maxScale, Math.sqrt(maxPixels / (width * height)));
    const picture = new Image();
    picture.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(markup);
    await picture.decode();
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    canvas.getContext("2d").drawImage(picture, 0, 0, canvas.width, canvas.height);
    return { markup, width, height, scale: canvas.width / width, png: canvas.toDataURL("image/png") };
    """#
}

private extension Double {
    func clamped(to range: ClosedRange<Double>) -> Double { Swift.min(Swift.max(self, range.lowerBound), range.upperBound) }
}

/// A `mermaid` code block drawn as its diagram, fitted to the column; a tap opens it to pinch and zoom.
/// A source that does not draw shows why, over the source itself. `pending` marks a block whose
/// fence has not closed yet, so its source still grows with the stream.
struct MermaidBlockView: View {
    var source: String
    var pending = false
    @Environment(\.palette) private var palette
    @State private var result: MermaidResult?
    @State private var drawnFor: String?
    @State private var opened: MermaidDiagram?

    private static let maxHeight: CGFloat = 460

    var body: some View {
        let current = pending ? nil : drawnFor == "\(palette.dark)\n\(source)" ? result : MermaidRenderer.shared.cached(source, dark: palette.dark)
        Group {
            switch current {
            case .drawn(let diagram):
                Button { opened = diagram } label: { picture(diagram) }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Diagram")
                    .accessibilityHint("Opens the diagram to zoom")
            case .failed(let message):
                VStack(alignment: .leading, spacing: 8) {
                    Label("Diagram could not be rendered", systemImage: "exclamationmark.triangle")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(palette.danger)
                    SwiftUI.Text(message)
                        .font(.caption.monospaced())
                        .foregroundStyle(palette.muted)
                        .fixedSize(horizontal: false, vertical: true)
                    CodeBlockView(code: source, language: "mermaid")
                }
            case nil:
                SwiftUI.Text("Rendering diagram…")
                    .font(.footnote)
                    .foregroundStyle(palette.muted)
                    .frame(maxWidth: .infinity, minHeight: 120)
                    .background(palette.sunken, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(palette.lineSoft))
            }
        }
        .task(id: "\(pending)\(palette.dark)\n\(source)") {
            guard !pending else { return }
            let dark = palette.dark
            let drawn = await MermaidRenderer.shared.draw(source, dark: dark)
            guard !Task.isCancelled else { return }
            result = drawn
            drawnFor = "\(dark)\n\(source)"
        }
        .fullScreenCover(item: Binding(get: { opened.map(Opened.init) }, set: { opened = $0?.diagram })) { item in
            MermaidViewer(diagram: item.diagram)
        }
    }

    private func picture(_ diagram: MermaidDiagram) -> some View {
        let natural = diagram.size
        return SwiftUI.Image(uiImage: diagram.image)
            .resizable()
            .interpolation(.high)
            .aspectRatio(natural, contentMode: .fit)
            .frame(maxWidth: natural.width, maxHeight: min(natural.height, Self.maxHeight))
            .padding(14)
            .frame(maxWidth: .infinity)
            .background(palette.sunken, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(palette.lineSoft))
            .overlay(alignment: .topTrailing) {
                SwiftUI.Image(systemName: "arrow.up.left.and.arrow.down.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(palette.muted)
                    .padding(10)
            }
            .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private struct Opened: Identifiable {
        let diagram: MermaidDiagram
        var id: ObjectIdentifier { ObjectIdentifier(diagram) }
    }
}

/// A diagram over the whole screen, fitted on entry, then pinched or double-tapped to zoom.
struct MermaidViewer: View {
    var diagram: MermaidDiagram
    @Environment(\.palette) private var palette
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ZStack(alignment: .topTrailing) {
            ZoomableSVG(markup: diagram.markup, size: diagram.size, background: palette.canvas)
                .ignoresSafeArea()
            Button { dismiss() } label: {
                SwiftUI.Image(systemName: "xmark")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(palette.ink)
                    .frame(width: 44, height: 44)
                    .closeSurface(palette)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Close diagram")
            .padding(.trailing, 16)
            .padding(.top, 8)
        }
        .background(palette.canvas.ignoresSafeArea())
        .preferredColorScheme(palette.scheme)
    }
}

private extension View {
    @ViewBuilder func closeSurface(_ palette: Palette) -> some View {
        if #available(iOS 26, *) {
            glassEffect(.regular.interactive(), in: Circle())
        } else {
            background(palette.surface, in: Circle()).overlay(Circle().strokeBorder(palette.lineSoft))
        }
    }
}

/// The diagram's SVG in a web view, so it stays sharp at any zoom.
private struct ZoomableSVG: UIViewRepresentable {
    var markup: String
    var size: CGSize
    var background: Color

    static let maxZoom = 8

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let web = WKWebView(frame: .zero, configuration: configuration)
        web.isOpaque = false
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.scrollView.bouncesZoom = true
        let doubleTap = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.zoom(_:)))
        doubleTap.numberOfTapsRequired = 2
        doubleTap.delegate = context.coordinator
        web.scrollView.addGestureRecognizer(doubleTap)
        return web
    }

    func updateUIView(_ web: WKWebView, context: Context) {
        let ground = Self.css(background)
        guard context.coordinator.shown != markup + ground else { return }
        context.coordinator.shown = markup + ground
        web.backgroundColor = UIColor(background)
        let aspect = size.width / max(size.height, 1)
        let page = """
        <!doctype html><html><head><meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=\(Self.maxZoom), viewport-fit=cover">
        <style>
        html, body { margin: 0; height: 100%; background: \(ground); }
        body { display: flex; align-items: center; justify-content: center; }
        svg { display: block; flex: none; height: auto;
              width: min(calc(100vw - env(safe-area-inset-left) - env(safe-area-inset-right) - 32px),
                         calc((100vh - env(safe-area-inset-top) - env(safe-area-inset-bottom) - 120px) * \(aspect))); }
        </style></head><body>\(markup)</body></html>
        """
        web.loadHTMLString(page, baseURL: nil)
    }

    private static func css(_ color: Color) -> String {
        var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
        UIColor(color).getRed(&red, green: &green, blue: &blue, alpha: &alpha)
        return "rgb(\(Int(red * 255)), \(Int(green * 255)), \(Int(blue * 255)))"
    }

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        var shown: String?

        @objc func zoom(_ gesture: UITapGestureRecognizer) {
            guard let scroll = gesture.view as? UIScrollView else { return }
            if scroll.zoomScale > scroll.minimumZoomScale + 0.01 {
                scroll.setZoomScale(scroll.minimumZoomScale, animated: true)
                return
            }
            let target = min(3, scroll.maximumZoomScale)
            guard let content = scroll.delegate?.viewForZooming?(in: scroll) else { return }
            let point = gesture.location(in: content)
            let size = CGSize(width: scroll.bounds.width / target, height: scroll.bounds.height / target)
            scroll.zoom(to: CGRect(x: point.x - size.width / 2, y: point.y - size.height / 2, width: size.width, height: size.height), animated: true)
        }

        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }
    }
}
