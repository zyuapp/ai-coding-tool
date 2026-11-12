import { always, next, now } from "@antithesishq/bombadil";
import { actions, extract, registerCustomAction, weighted } from "@antithesishq/bombadil/browser";
import { clicks, inputs, lastAction, reload, scroll, waitOnce } from "@antithesishq/bombadil/browser/defaults/actions";
export { noConsoleErrors, noHttpErrorCodes, noUncaughtExceptions, noUnhandledPromiseRejections } from "@antithesishq/bombadil/browser/defaults/properties";

const ESCAPE = 27;

const partFailures = extract((state) => state.document.querySelectorAll(".part-fallback").length);
export const noPartFailure = always(() => partFailures.current === 0);

/** The window is a fixed full-size layout, so the page itself never scrolls. */
const pageOverflow = extract((state) => {
  const root = state.document.documentElement;
  return Math.max(root.scrollWidth - state.window.innerWidth, root.scrollHeight - state.window.innerHeight);
});
export const noPageOverflow = always(() => pageOverflow.current <= 1);

/** Escape never leaves the keys on `<body>`, where only the mouse can bring them back. */
const focusOnBody = extract((state) => state.document.activeElement === null || state.document.activeElement === state.document.body);
const escapePressed = () => {
  const action = lastAction.current;
  return action !== null && typeof action === "object" && "PressKey" in action && action.PressKey.code === ESCAPE;
};
export const escapeKeepsFocus = always(now(() => !focusOnBody.current).implies(next(() => !(escapePressed() && focusOnBody.current))));

const focusedField = extract((state) => {
  const element = state.document.activeElement;
  return element instanceof HTMLTextAreaElement || (element instanceof HTMLInputElement && element.type === "text");
});

const NASTY = [
  "👩‍👩‍👧‍👦🏳️‍🌈🧑🏽‍💻",
  "مرحبا بالعالم שלום",
  "‮reversed‬ text",
  "line one\nline two\n\n\nline five",
  "<img src=x onerror=alert(1)>",
  "`".repeat(9) + "```ts\nunterminated",
  "$(rm -rf /) && echo $HOME",
  "x".repeat(2000),
  "\t\t indented\u0000null​zero-width",
  "/", "@", "#",
];

/** What a paste or an IME commit does: replace the selection and announce one input. */
const typeNasty = registerCustomAction("typeNasty", async (document, _window, which: number) => {
  const element = document.activeElement;
  if (!(element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement)) return;
  const text = NASTY[which % NASTY.length]!;
  element.setRangeText(text, element.selectionStart ?? element.value.length, element.selectionEnd ?? element.value.length, "end");
  element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
});

const pasteText = registerCustomAction("pasteText", async (document, _window, size: number) => {
  const element = document.activeElement;
  if (!(element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement)) return;
  const data = new DataTransfer();
  data.setData("text/plain", "lorem ipsum dolor sit amet\n".repeat(Math.ceil(size / 27)).slice(0, size));
  element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }));
});

const SHORTCUTS = [
  "composer.focus", "dock.toggle", "dock.expand", "effort.decrease", "effort.increase", "find.open", "find.next", "find.previous",
  "nav.back", "nav.forward", "project.start", "run.allow", "run.deny", "settings.toggle", "sidebar.toggle", "tab.close",
  "tab.new", "terminal.focus", "thread.jump", "thread.new", "thread.new-pick-project", "zen.toggle",
];
/** A menu or keyboard shortcut, delivered the way the main process hands it to the window. */
const shortcut = registerCustomAction("shortcut", async (_document, window, index: number) => {
  const { desktop } = (window as unknown as { __fuzz: { desktop: { pressShortcut: (action: string, surface?: string) => void } } }).__fuzz;
  desktop.pressShortcut(SHORTCUTS[index % SHORTCUTS.length]!, "any");
});

const nastyInputs = actions(() => focusedField.current ? [...NASTY.map((_, index) => typeNasty(index)), pasteText(2_000), pasteText(50_000)] : []);
const keys = weighted([
  [3, { PressKey: { code: ESCAPE } }],
  [2, { PressKey: { code: 9 } }],
  [1, { PressKey: { code: 13 } }],
  [1, { PressKey: { code: 38 } }],
  [1, { PressKey: { code: 40 } }],
]);
const shortcuts = actions(() => SHORTCUTS.map((_, index) => shortcut(index)));
const resize = weighted([
  [1, { SetViewport: { width: 1440, height: 900 } }],
  [1, { SetViewport: { width: 1024, height: 700 } }],
  [1, { SetViewport: { width: 760, height: 620 } }],
  [1, { SetViewport: { width: 520, height: 700 } }],
]);

export const explore = weighted([
  [60, clicks],
  [15, inputs],
  [8, nastyInputs],
  [8, keys],
  [6, shortcuts],
  [6, scroll],
  [3, waitOnce],
  [2, resize],
  [1, reload],
]);
