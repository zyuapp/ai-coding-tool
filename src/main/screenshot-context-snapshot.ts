import { MAX_SCREENSHOT_CONTEXT_TEXT, type AccessibilitySnapshot, type ScreenshotPlatform } from "../domain/screenshot-context.js";
import { isDocumentRole, isProtectedRole, screenshotTree } from "./screenshot-context-tree.js";

export const SCREENSHOT_CONTEXT_MAX_ELEMENTS = 2_000;
export const SCREENSHOT_CONTEXT_MAX_DEPTH = 50;
const MAX_RESULT_LENGTH = 1_000_000;
const MAX_LINE_LENGTH = 1_200;

export type ScreenshotTarget = {
  platform: ScreenshotPlatform;
  pid: number;
  windowId: number;
  app: string;
  title: string;
};

type ContextDriver = {
  callTool(name: string, argumentsJson: string): Promise<{ isError: boolean; structuredJson?: string }>;
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Hyprland's stableId names a grim toplevel; CUA 0.24 uses the full compositor address. */
export function hyprlandAccessibilityWindowId(address: unknown): number | null {
  if (typeof address !== "string" || !/^0x[\da-f]+$/i.test(address)) return null;
  const id = Number(address);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** A bounded native read, with no screenshot, input action, or focus change. */
export async function snapshotWindowAccessibility(driver: ContextDriver, target: ScreenshotTarget, partial?: (snapshot: AccessibilitySnapshot) => void): Promise<AccessibilitySnapshot> {
  const input = JSON.stringify({
    pid: target.pid,
    window_id: target.windowId,
    include_screenshot: false,
    max_elements: SCREENSHOT_CONTEXT_MAX_ELEMENTS,
    max_depth: SCREENSHOT_CONTEXT_MAX_DEPTH,
  });
  const read = async (): Promise<AccessibilitySnapshot> => {
    const result = await driver.callTool("get_window_state", input);
    if (result.isError || !result.structuredJson || result.structuredJson.length > MAX_RESULT_LENGTH) return { status: "unavailable", reason: "failed" };
    return accessibilityFromSnapshot(JSON.parse(result.structuredJson), target);
  };
  const first = await read();
  // A newly enabled Chromium tree can initially expose only its title bar. Let it settle once,
  // within the same process/deadline; retain the first usable read if the follow-up stalls.
  const sparse = first.status === "captured" && !/(?:^|\n)\s*- (?:AXStaticText|AXTextArea|AXHeading|AXOutline|AXTable|label|static|paragraph|heading|text|table)(?=\s|$)/.test(first.text);
  if (!sparse && !(first.status === "unavailable" && ["window", "empty"].includes(first.reason))) return first;
  if (first.status === "captured") partial?.(first);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const second = await read();
  return second.status === "captured" ? second : first;
}

/**
 * The structured CUA array omits passive labels. Preserve its Markdown tree for those labels,
 * supplementing indexed controls with their typed states. Never send actionable snapshot tokens.
 */
export function accessibilityFromSnapshot(snapshot: unknown, target: ScreenshotTarget): AccessibilitySnapshot {
  if (!record(snapshot) || snapshot.pid !== target.pid || snapshot.window_id !== target.windowId
    || (typeof snapshot.window_title === "string" && snapshot.window_title !== target.title)) return { status: "unavailable", reason: "window" };
  // In particular, CUA marks ambiguous Hyprland AT-SPI matches as application-scoped.
  if (snapshot.degraded === true) return { status: "unavailable", reason: "window" };
  if (typeof snapshot.tree_markdown !== "string" || !snapshot.tree_markdown.trim()) return { status: "unavailable", reason: "empty" };
  const tree = screenshotTree(snapshot.tree_markdown, target.platform);
  const allLines = tree.rows;
  // macOS also supplies the application's menu bar, including menus outside the captured image.
  // Keep exactly the captured window's subtree on both platforms.
  const rootPattern = target.platform === "macos" ? /^AXWindow$/ : /^(?:frame|window|dialog|alert|file chooser)$/;
  const candidates = allLines.flatMap((line, index) => rootPattern.test(line.role) ? [{ index, depth: line.depth }] : []);
  const rootDepth = Math.min(...candidates.map((root) => root.depth));
  const roots = candidates.filter((root) => root.depth === rootDepth);
  if (roots.length !== 1) return { status: "unavailable", reason: "window" };
  const root = roots[0];
  const end = allLines.findIndex((line, index) => index > root.index && line.depth <= root.depth);
  const lines = allLines.slice(root.index, end === -1 ? undefined : end);
  if (target.platform !== "macos") {
    // X11 can return an application-wide tree if geometry did not resolve its top-level.
    // Accept only one named window root, belonging to the captured window; never guess a sibling.
    const first = lines[0].text.trimStart();
    const prefix = /^- (?:\[\d+\] )?(?:frame|window|dialog|alert|file chooser)(?: =)? /.exec(first);
    const title = prefix ? first.slice(prefix[0].length) : "";
    // CUA's tree renderer quotes labels literally. Newlines cannot establish a unique root.
    const expected = `"${target.title}"`;
    if (!prefix || /[\r\n]/.test(target.title) || (title !== expected && !title.startsWith(`${expected} [actions=`))) return { status: "unavailable", reason: "window" };
  }
  const elements = new Map<number, Record<string, unknown>>();
  if (Array.isArray(snapshot.elements)) {
    for (const element of snapshot.elements.slice(0, SCREENSHOT_CONTEXT_MAX_ELEMENTS)) {
      if (record(element) && typeof element.element_index === "number") elements.set(element.element_index, element);
    }
  }
  const formatted: Array<{ text: string; document: boolean }> = [];
  let protectedDepth: number | null = null;
  let documentDepth: number | null = null;
  // CUA counts actionable elements separately from its cap on all visited nodes.
  // Its explicit walk warning is authoritative; a small element_count can still be capped.
  let truncated = tree.truncated;
  for (const row of lines.slice(0, SCREENSHOT_CONTEXT_MAX_ELEMENTS * 2)) {
    const { text: raw, depth, role, index } = row;
    if (documentDepth !== null && depth <= documentDepth) documentDepth = null;
    if (documentDepth === null && isDocumentRole(role)) documentDepth = depth;
    if (protectedDepth !== null && depth > protectedDepth) continue;
    protectedDepth = null;
    if (isProtectedRole(role)) { protectedDepth = depth; continue; }
    const element = index === undefined ? undefined : elements.get(index);
    const states = element ? ["enabled", "selected", "checked"].flatMap((key) => typeof element[key] === "boolean" ? [`${key}=${element[key]}`] : []) : [];
    if (element && typeof element.checked !== "boolean" && /check.?box|radio.?button/i.test(String(element.role))) {
      if (["1", "true", "on"].includes(String(element.value))) states.push("checked=true");
      if (["0", "false", "off"].includes(String(element.value))) states.push("checked=false");
    }
    if (element && record(element.frame) && !/^(?:AXStaticText|AXHeading|label|static|heading|paragraph)$/.test(role)) {
      const frame = [element.frame.x, element.frame.y, element.frame.w, element.frame.h];
      if (frame.every((part) => typeof part === "number" && Number.isFinite(part)) && Number(frame[2]) > 0 && Number(frame[3]) > 0) states.push(`desktop bounds=${JSON.stringify(frame)}`);
    }
    // Numeric AX values (checkboxes/sliders) may only be present on the structured side.
    if (element && typeof element.value === "string" && element.value) {
      const renderedValue = element.value.trim().replace(/\r?\n\s*/g, "\\n");
      if (!raw.includes(`= "${renderedValue}"`) && !raw.includes(`value="${renderedValue}"`)) states.push(`value=${JSON.stringify(element.value.slice(0, MAX_LINE_LENGTH))}`);
    }
    let line = raw.replace(/^(\s*-?\s*)\[(?:element_index )?\d+\]\s*/, "$1")
      .replace(/\s*\[(?:id=|help=|actions=).*\]\s*$/, "")
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
    if (states.length) line += ` (${states.join(", ")})`;
    if (line.length > MAX_LINE_LENGTH) { line = `${line.slice(0, MAX_LINE_LENGTH - 1)}…`; truncated = true; }
    formatted.push({ text: line, document: documentDepth !== null || element?.in_web_content === true });
  }
  if (lines.length > SCREENSHOT_CONTEXT_MAX_ELEMENTS * 2) truncated = true;
  const fit = (rows: typeof formatted, budget: number) => {
    const kept: string[] = [];
    let used = 0;
    for (const row of rows) {
      if (used + row.text.length + 1 > budget) { truncated = true; continue; }
      kept.push(row.text);
      used += row.text.length + 1;
    }
    return { text: kept.join("\n"), used };
  };
  const documents = formatted.filter((row) => row.document);
  // Reserve room for document content even when bookmarks, tabs, or app controls are extensive.
  const chrome = fit(documents.length ? formatted.filter((row) => !row.document) : formatted, documents.length ? 2_000 : MAX_SCREENSHOT_CONTEXT_TEXT);
  const page = fit(documents, MAX_SCREENSHOT_CONTEXT_TEXT - chrome.used);
  const text = [chrome.text, page.text].filter(Boolean).join("\n").trim();
  return text ? { status: "captured", text, truncated } : { status: "unavailable", reason: "empty" };
}
