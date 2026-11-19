import SwiftUI
import UIKit
import WebKit

extension VisualFrame {
    /// The theme as it stands, with the reply's own type, so the visual matches the prose around it.
    static func theme(_ palette: Palette) -> (scheme: String, vars: [String: String]) {
        var vars = palette.visualColors
        vars["--font-sans"] = "-apple-system, system-ui, sans-serif"
        vars["--font-mono"] = "ui-monospace, Menlo, monospace"
        vars["--font-size"] = "\(Int(UIFont.preferredFont(forTextStyle: .body).pointSize.rounded()))px"
        vars["--radius"] = "10px"
        return (palette.dark ? "dark" : "light", vars)
    }
}

/// The height each visual last reported. A reply is rebuilt whenever the thread reopens, and a frame
/// that starts at a guessed height would shift everything below it once the visual measured.
@MainActor
private enum VisualHeights {
    private static var heights: [String: CGFloat] = [:]
    private static var order: [String] = []
    private static let limit = 64

    static func get(_ source: String) -> CGFloat? { heights[source] }

    static func set(_ source: String, _ height: CGFloat) {
        if heights.updateValue(height, forKey: source) == nil { order.append(source) }
        while order.count > limit { heights[order.removeFirst()] = nil }
    }

    static func forget(_ source: String) {
        heights[source] = nil
        order.removeAll { $0 == source }
    }
}

/// A `visual` code block drawn live at the column's width and its content's height. It starts once it
/// scrolls into view; a visual that fails says why and can be tried again. `pending` marks a block
/// whose fence has not closed yet, so its source still grows with the stream.
struct VisualBlockView: View {
    var source: String
    var pending = false
    @Environment(\.palette) private var palette
    @State private var visible = false
    @State private var height: CGFloat?
    @State private var error: String?
    /// Each try draws into a fresh page, so a visual that failed starts again from nothing.
    @State private var attempt = 0

    var body: some View {
        let live = visible && !pending
        let known = height ?? VisualHeights.get(source)
        VStack(alignment: .leading, spacing: Space.s) {
            ZStack(alignment: .top) {
                if live {
                    VisualWebView(source: source, palette: palette) { message in
                        switch message {
                        case .size(let value):
                            VisualHeights.set(source, value)
                            height = value
                        case .error(let text):
                            if error == nil { error = text }
                        }
                    }
                    .id(attempt)
                    .frame(height: height ?? (error == nil ? known ?? 120 : 0))
                    .opacity(height == nil ? 0 : 1)
                    .animation(.easeOut(duration: 0.18), value: height == nil)
                }
                if height == nil, error == nil {
                    SwiftUI.Text("Drawing visual…")
                        .font(.footnote)
                        .foregroundStyle(palette.muted)
                        .shimmer(palette.ink)
                        .frame(maxWidth: .infinity, minHeight: known ?? 120)
                        .background(palette.sunken, in: RoundedRectangle(cornerRadius: Radius.block, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: Radius.block, style: .continuous).strokeBorder(palette.lineSoft))
                        .allowsHitTesting(false)
                }
            }
            if let error { failure(error) }
        }
        .onScrollVisibilityChange(threshold: 0.01) { shown in
            if shown { visible = true }
        }
        .task(id: "\(live) \(attempt)") {
            guard live else { return }
            try? await Task.sleep(for: VisualFrame.timeout)
            guard !Task.isCancelled, height == nil, error == nil else { return }
            error = "The visual did not finish drawing."
        }
    }

    private func failure(_ message: String) -> some View {
        VStack(alignment: .leading, spacing: Space.s) {
            Label("The visual hit an error", systemImage: "exclamationmark.triangle")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(palette.danger)
            SwiftUI.Text(message)
                .font(.caption.monospaced())
                .foregroundStyle(palette.muted)
                .fixedSize(horizontal: false, vertical: true)
            Button {
                VisualHeights.forget(source)
                height = nil
                error = nil
                attempt += 1
            } label: {
                SwiftUI.Text("Try again")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(palette.ink)
                    .padding(.horizontal, 14)
                    .frame(height: 32)
                    .background(palette.raised, in: Capsule())
                    .minimumTapTarget()
            }
            .buttonStyle(.target)
        }
    }
}

/// The page a visual draws in. Navigation, popups, and storage that outlives the app are all refused.
private struct VisualWebView: UIViewRepresentable {
    var source: String
    var palette: Palette
    var onMessage: (VisualFrame.Message) -> Void

    /// One store for every visual, so they share a session and keep nothing once the app quits.
    @MainActor private static let store = WKWebsiteDataStore.nonPersistent()

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let coordinator = context.coordinator
        coordinator.source = source
        coordinator.palette = palette
        coordinator.onMessage = onMessage
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = Self.store
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.allowsInlineMediaPlayback = true
        configuration.dataDetectorTypes = []
        configuration.userContentController.addUserScript(WKUserScript(source: VisualFrame.bridge, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        configuration.userContentController.add(Relay(coordinator), name: "visual")
        let web = WKWebView(frame: .zero, configuration: configuration)
        web.isOpaque = false
        web.backgroundColor = .clear
        web.scrollView.backgroundColor = .clear
        web.scrollView.isScrollEnabled = false
        web.scrollView.bounces = false
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.scrollView.pinchGestureRecognizer?.isEnabled = false
        web.navigationDelegate = coordinator
        web.loadHTMLString(VisualFrame.page, baseURL: VisualFrame.origin)
        return web
    }

    func updateUIView(_ web: WKWebView, context: Context) {
        let coordinator = context.coordinator
        coordinator.onMessage = onMessage
        coordinator.scrolls = { web.scrollView.isScrollEnabled = $0 }
        guard coordinator.palette != palette else { return }
        coordinator.palette = palette
        coordinator.restyle(web)
    }

    static func dismantleUIView(_ web: WKWebView, coordinator: Coordinator) {
        web.navigationDelegate = nil
        web.configuration.userContentController.removeScriptMessageHandler(forName: "visual")
        web.stopLoading()
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate {
        var source = ""
        var palette = Palette.fallbackDark
        var onMessage: (VisualFrame.Message) -> Void = { _ in }
        var scrolls: (Bool) -> Void = { _ in }
        private var started = false
        private var ready = false

        func received(_ body: Any) {
            guard let message = VisualFrame.message(body) else { return }
            if case .size(let height) = message { scrolls(height >= VisualFrame.maxHeight) }
            onMessage(message)
        }

        func restyle(_ web: WKWebView) {
            guard ready else { return }
            call(web, "window.__visual.theme(scheme, vars)", [:])
        }

        private func call(_ web: WKWebView, _ script: String, _ extra: [String: Any]) {
            let theme = VisualFrame.theme(palette)
            let arguments = extra.merging(["scheme": theme.scheme, "vars": theme.vars]) { first, _ in first }
            /// The Objective-C entry point: the Swift overloads live in a library iOS 18 does not ship.
            web.__callAsyncJavaScript(script, arguments: arguments, inFrame: nil, in: .page) { _, _ in }
        }

        /// The page itself is the only thing a visual's frame ever loads.
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
            if !started, action.targetFrame?.isMainFrame == true {
                started = true
                decisionHandler(.allow)
            } else {
                decisionHandler(.cancel)
            }
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            guard !ready else { return }
            ready = true
            call(webView, "window.__visual.render(html, scheme, vars)", ["html": source])
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            onMessage(.error("The visual stopped."))
        }
    }

    /// Holds the coordinator weakly, since the page's controller keeps its handlers alive.
    private final class Relay: NSObject, WKScriptMessageHandler {
        weak var coordinator: Coordinator?

        init(_ coordinator: Coordinator) { self.coordinator = coordinator }

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            MainActor.assumeIsolated { coordinator?.received(message.body) }
        }
    }
}
