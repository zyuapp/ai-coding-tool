import Foundation

/// An agent's `visual` fence: HTML, CSS, and script drawn live in its reply, as the desktop draws it.
/// It runs in a web view of its own that reaches nothing on the network, and talks to the app only
/// through the size and error messages below.
enum VisualFrame {
    static let language = "visual"
    /// The page's own origin, which nothing serves: an opaque one would hide every script error's message.
    static let origin = URL(string: "aicodingtool-visual://frame/")
    /// Larger than any reasonable visual, small enough that a runaway one stays a code block.
    static let maxSource = 1_000_000
    /// A visual taller than this scrolls inside its frame, so a layout that grows with its frame cannot run away.
    static let maxHeight: CGFloat = 2000
    /// How long a visual may take to report its size before it is taken to have failed.
    static let timeout: Duration = .seconds(10)

    enum Message: Equatable {
        case size(CGFloat)
        case error(String)
    }

    /// What the page says is untrusted: the visual's own script can post anything the bridge can.
    static func message(_ body: Any) -> Message? {
        guard let fields = body as? [String: Any], let type = fields["type"] as? String else { return nil }
        if type == "size", let height = (fields["height"] as? NSNumber)?.doubleValue, height.isFinite {
            return .size(min(maxHeight, max(0, CGFloat(height.rounded(.up)))))
        }
        if type == "error", let text = fields["message"] as? String { return .error(String(text.prefix(500))) }
        return nil
    }

    /// Inline script and style are the visual itself; everything that would leave the page is refused.
    static let policy = [
        "default-src 'none'",
        "script-src 'unsafe-inline' 'unsafe-eval'",
        "style-src 'unsafe-inline'",
        "img-src data: blob:",
        "media-src data: blob:",
        "font-src data:",
        "form-action 'none'",
        "base-uri 'none'",
    ].joined(separator: "; ")

    static let page = """
    <!doctype html><html lang="en"><head><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="\(policy)">
    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
    <style>
    *, *::before, *::after { box-sizing: border-box; }
    html { background: transparent; overflow: hidden; -webkit-text-size-adjust: 100%; }
    body {
      position: relative; display: flow-root; margin: 0;
      color: var(--color-text); font: var(--font-size, 17px)/1.5 var(--font-sans, system-ui, sans-serif);
      accent-color: var(--color-accent); -webkit-font-smoothing: antialiased; -webkit-tap-highlight-color: transparent;
    }
    button, input, select, textarea { font: inherit; color: inherit; }
    </style></head><body></body></html>
    """

    /// Runs before anything else in the page. It takes the markup once, applies the theme whenever
    /// the app sends one, and reports the height the content needs, so the frame never scrolls a visual that fits.
    static let bridge = #"""
    (() => {
      const channel = window.webkit.messageHandlers.visual;
      const post = (message) => channel.postMessage(message);
      let rendered = false;
      let reported = -1;
      let queued = false;
      let failed = false;
      const measure = () => {
        queued = false;
        const body = document.body;
        const height = Math.ceil(Math.max(body.scrollHeight, body.getBoundingClientRect().height));
        document.documentElement.style.overflowY = height > 2000 ? "auto" : "hidden";
        if (height === reported) return;
        reported = height;
        post({ type: "size", height });
      };
      const schedule = () => {
        if (queued) return;
        queued = true;
        requestAnimationFrame(measure);
      };
      const style = (scheme, vars) => {
        const root = document.documentElement;
        for (const [name, value] of Object.entries(vars || {})) {
          if (/^--[a-z0-9-]+$/.test(name) && typeof value === "string") root.style.setProperty(name, value);
        }
        if (scheme === "light" || scheme === "dark") root.style.colorScheme = scheme;
      };
      const report = (message) => {
        if (failed) return;
        failed = true;
        post({ type: "error", message: String(message) });
      };
      /** A ResizeObserver loop is the browser deferring a notification the visual still receives. */
      addEventListener("error", (event) => {
        if (/^ResizeObserver loop/.test(event.message)) return;
        report(event.message || "Script error");
      });
      addEventListener("unhandledrejection", (event) => report(event.reason && event.reason.message || event.reason));
      Object.defineProperty(window, "__visual", { value: Object.freeze({
        theme(scheme, vars) {
          style(scheme, vars);
          dispatchEvent(new Event("visualthemechange"));
          schedule();
        },
        render(html, scheme, vars) {
          if (rendered || typeof html !== "string") return;
          rendered = true;
          style(scheme, vars);
          const template = document.createElement("template");
          template.innerHTML = html;
          /** Script parsed into a template never runs; a copy made here runs once it is in the page. */
          for (const inert of template.content.querySelectorAll("script")) {
            const live = document.createElement("script");
            for (const attribute of inert.attributes) live.setAttribute(attribute.name, attribute.value);
            live.textContent = inert.textContent;
            inert.replaceWith(live);
          }
          const body = document.body;
          new ResizeObserver(schedule).observe(body);
          new MutationObserver(schedule).observe(body, { subtree: true, childList: true, attributes: true, characterData: true });
          addEventListener("load", schedule, true);
          body.append(template.content);
          schedule();
        },
      }) });
    })();
    """#
}
