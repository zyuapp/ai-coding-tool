import { protocol, type WebContents } from "electron";
import { isVisualFrameUrl, VISUAL_FRAME_CSP, VISUAL_FRAME_URL, VISUAL_SCHEME, visualFrameDocument } from "../domain/visual-frame.js";

/** The scheme serves one page, the empty frame a visual is posted into; nothing a URL names is ever read. */
export function visualFrameResponse(url: string): Response {
  if (url.split(/[?#]/)[0] !== VISUAL_FRAME_URL) return new Response("Not found", { status: 404 });
  return new Response(visualFrameDocument(), { headers: {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": VISUAL_FRAME_CSP,
    "X-Content-Type-Options": "nosniff",
  } });
}

export function handleVisualProtocol() {
  protocol.handle(VISUAL_SCHEME, (request) => visualFrameResponse(request.url));
}

/**
 * A sandboxed frame may still navigate itself, which is how a visual would reach the network. The
 * window has no other frames, so any frame leaving the visual page is stopped.
 */
export function guardVisualFrames(contents: WebContents) {
  contents.on("will-frame-navigate", (event) => {
    if (!event.isMainFrame && !isVisualFrameUrl(event.url)) event.preventDefault();
  });
}
