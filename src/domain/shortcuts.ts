/**
 * The keyboard, as data. An action names something the app can do; a binding is the keystroke that
 * asks for it. Matching happens in the main process, because the browser panel's pages never let a
 * keystroke reach the window, so this module has to describe a keystroke both sides recognise.
 */

/**
 * Where a binding is claimed: anywhere in the app, only while a page in the panel has the keys, or
 * across the whole desktop, which the app holds even while another app has the keyboard.
 */
export type ShortcutSurface = "any" | "browser" | "desktop";

export type ShortcutAction = {
  id: string;
  group: string;
  label: string;
  description: string;
  surface: ShortcutSurface;
  /** What the action is bound to until the user says otherwise. */
  defaultBinding: string;
};

/** One keystroke, named so the same value survives a keyboard layout and a platform. */
export type Keystroke = {
  key: string;
  /** The platform's own command key: ⌘ on macOS, Ctrl everywhere else. */
  mod: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
};

/** A keystroke as the window and the panel's pages both report it. */
export type KeyInput = {
  key: string;
  code: string;
  meta: boolean;
  control: boolean;
  alt: boolean;
  shift: boolean;
};

export type ShortcutBinding = { action: string; binding: string; surface: ShortcutSurface };

/** What the settings list shows: the action, what it is bound to now, and whether that is the default. */
export type ShortcutSetting = ShortcutAction & { binding: string | null; changed: boolean };

/** The user's own bindings, by action. A `null` is an action they took the keystroke away from. */
export type ShortcutOverrides = Record<string, string | null>;

const MODIFIERS = ["Mod", "Ctrl", "Alt", "Shift"] as const;

const PUNCTUATION: Record<string, string> = {
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backslash: "\\",
  BracketLeft: "[",
  BracketRight: "]",
  Minus: "-",
  Equal: "=",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
};

const NAMED_KEYS = new Set([
  "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown",
  "Enter", "Space", "Tab", "Escape", "Backspace", "Delete",
  "Home", "End", "PageUp", "PageDown",
]);

const PUNCTUATION_KEYS = new Set(Object.values(PUNCTUATION));

function isFunctionKey(key: string) {
  return /^F([1-9]|1[0-2])$/.test(key);
}

/** Whether a key is one a binding may name at all. */
function isBindableKey(key: string) {
  return /^[A-Z0-9]$/.test(key) || PUNCTUATION_KEYS.has(key) || NAMED_KEYS.has(key) || isFunctionKey(key);
}

/**
 * The key a binding names, taken from the physical key rather than the character it produced, so
 * ⌥N is the N key and not the dead key macOS turns it into.
 */
export function shortcutKey(code: string, key: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (code in PUNCTUATION) return PUNCTUATION[code];
  if (NAMED_KEYS.has(code) || isFunctionKey(code)) return code;
  /** A layout that reports no code of its own still knows what the key produced. */
  const produced = key.length === 1 ? key.toUpperCase() : key;
  return isBindableKey(produced) ? produced : null;
}

export function keystrokeOf(input: KeyInput, mac: boolean): Keystroke | null {
  const key = shortcutKey(input.code, input.key);
  if (key === null) return null;
  return {
    key,
    mod: mac ? input.meta : input.control,
    ctrl: mac ? input.control : input.meta,
    alt: input.alt,
    shift: input.shift,
  };
}

export function formatShortcut(stroke: Keystroke): string {
  return [
    ...(stroke.mod ? ["Mod"] : []),
    ...(stroke.ctrl ? ["Ctrl"] : []),
    ...(stroke.alt ? ["Alt"] : []),
    ...(stroke.shift ? ["Shift"] : []),
    stroke.key,
  ].join("+");
}

/** Anything unreadable is no binding at all, so a stored value the app no longer knows simply goes. */
export function parseShortcut(text: unknown): Keystroke | null {
  if (typeof text !== "string" || !text) return null;
  const parts = text.split("+");
  const key = parts.pop() ?? "";
  if (!isBindableKey(key)) return null;
  const stroke: Keystroke = { key, mod: false, ctrl: false, alt: false, shift: false };
  for (const part of parts) {
    if (part === "Mod" && !stroke.mod) stroke.mod = true;
    else if (part === "Ctrl" && !stroke.ctrl) stroke.ctrl = true;
    else if (part === "Alt" && !stroke.alt) stroke.alt = true;
    else if (part === "Shift" && !stroke.shift) stroke.shift = true;
    else return null;
  }
  return stroke;
}

const MAC_MODIFIER_SYMBOLS: Record<(typeof MODIFIERS)[number], string> = { Ctrl: "⌃", Alt: "⌥", Shift: "⇧", Mod: "⌘" };
const OTHER_MODIFIER_NAMES: Record<(typeof MODIFIERS)[number], string> = { Mod: "Ctrl", Ctrl: "Meta", Alt: "Alt", Shift: "Shift" };

const KEY_SYMBOLS: Record<string, string> = {
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  Enter: "↩",
  Escape: "Esc",
  Backspace: "⌫",
  Delete: "⌦",
  Tab: "⇥",
  PageUp: "⇞",
  PageDown: "⇟",
  Home: "↖",
  End: "↘",
};

/** How a binding reads on screen. macOS puts its modifiers in one order and writes them as symbols. */
export function displayShortcut(binding: string, mac: boolean): string {
  const stroke = parseShortcut(binding);
  if (!stroke) return "";
  const key = mac ? KEY_SYMBOLS[stroke.key] ?? stroke.key : stroke.key;
  if (!mac) {
    return [
      ...(stroke.mod ? [OTHER_MODIFIER_NAMES.Mod] : []),
      ...(stroke.ctrl ? [OTHER_MODIFIER_NAMES.Ctrl] : []),
      ...(stroke.alt ? [OTHER_MODIFIER_NAMES.Alt] : []),
      ...(stroke.shift ? [OTHER_MODIFIER_NAMES.Shift] : []),
      key,
    ].join("+");
  }
  return [
    ...(stroke.ctrl ? [MAC_MODIFIER_SYMBOLS.Ctrl] : []),
    ...(stroke.alt ? [MAC_MODIFIER_SYMBOLS.Alt] : []),
    ...(stroke.shift ? [MAC_MODIFIER_SYMBOLS.Shift] : []),
    ...(stroke.mod ? [MAC_MODIFIER_SYMBOLS.Mod] : []),
    key,
  ].join("");
}

export const SHORTCUT_MODIFIER_REQUIRED = "A shortcut needs ⌘, ⌥, or ⌃ so it cannot swallow what you type.";
export const SHORTCUT_RESERVED = "That keystroke belongs to the desktop.";

/** Why a keystroke cannot be bound, or null when it can. */
export function shortcutProblem(binding: string): string | null {
  const stroke = parseShortcut(binding);
  if (!stroke) return SHORTCUT_RESERVED;
  if (!stroke.mod && !stroke.ctrl && !stroke.alt) return SHORTCUT_MODIFIER_REQUIRED;
  if (stroke.key === "Tab" || (stroke.key === "Q" && stroke.mod && !stroke.ctrl && !stroke.alt && !stroke.shift)) return SHORTCUT_RESERVED;
  return null;
}

export const SHORTCUT_ACTIONS: readonly ShortcutAction[] = [
  { id: "thread.new", group: "Threads", label: "New thread", description: "Start a thread in the project you are in", surface: "any", defaultBinding: "Mod+N" },
  { id: "thread.new-worktree", group: "Threads", label: "New thread in a worktree", description: "Start a thread that gets a checkout of its own", surface: "any", defaultBinding: "Mod+Shift+N" },
  { id: "thread.previous", group: "Threads", label: "Previous thread", description: "Move up the sidebar", surface: "any", defaultBinding: "Mod+Alt+ArrowLeft" },
  { id: "thread.next", group: "Threads", label: "Next thread", description: "Move down the sidebar", surface: "any", defaultBinding: "Mod+Alt+ArrowRight" },
  { id: "run.cancel", group: "Threads", label: "Stop the run", description: "Cancel what this thread is doing", surface: "any", defaultBinding: "Mod+." },
  { id: "run.allow", group: "Threads", label: "Allow", description: "Answer the approval this thread is waiting on", surface: "any", defaultBinding: "Mod+Shift+A" },
  { id: "run.deny", group: "Threads", label: "Deny", description: "Refuse the approval this thread is waiting on", surface: "any", defaultBinding: "Mod+Shift+D" },
  { id: "composer.focus", group: "Threads", label: "Focus the composer", description: "Put the caret in the prompt", surface: "any", defaultBinding: "Mod+L" },

  { id: "find.open", group: "Find", label: "Find", description: "Search the transcript, the page, or the shell you are reading", surface: "any", defaultBinding: "Mod+F" },
  { id: "find.next", group: "Find", label: "Next match", description: "Move to the match after this one", surface: "any", defaultBinding: "Mod+G" },
  { id: "find.previous", group: "Find", label: "Previous match", description: "Move to the match before this one", surface: "any", defaultBinding: "Mod+Shift+G" },

  { id: "nav.back", group: "Navigation", label: "Back", description: "The thread you came from, or the page before this one", surface: "any", defaultBinding: "Mod+[" },
  { id: "nav.forward", group: "Navigation", label: "Forward", description: "The thread you came back from, or the page after this one", surface: "any", defaultBinding: "Mod+]" },
  { id: "page.reload", group: "Navigation", label: "Reload the page", description: "Only while a page in the panel has the keys", surface: "browser", defaultBinding: "Mod+R" },

  { id: "tab.new", group: "Panels", label: "New tab", description: "Another page, another shell, or a shell when the panel holds neither", surface: "any", defaultBinding: "Mod+T" },
  { id: "tab.close", group: "Panels", label: "Close", description: "Whatever is in front, then the panel, then the window", surface: "any", defaultBinding: "Mod+W" },
  { id: "dock.toggle", group: "Panels", label: "Show or hide the panel", description: "The right dock", surface: "any", defaultBinding: "Mod+\\" },
  { id: "dock.expand", group: "Panels", label: "Expand or restore the panel", description: "The right dock across the whole workspace", surface: "any", defaultBinding: "Mod+Shift+\\" },
  { id: "sidebar.toggle", group: "Panels", label: "Show or hide the sidebar", description: "The thread list", surface: "any", defaultBinding: "Mod+B" },
  { id: "settings.toggle", group: "Panels", label: "Settings", description: "Open settings, or leave them", surface: "any", defaultBinding: "Mod+," },
  ...["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth"].map((ordinal, index) => ({
    id: `dock.tab-${index + 1}`,
    group: "Panels",
    label: `Panel tab ${index + 1}`,
    description: `Show the ${ordinal} tab in the panel`,
    surface: "any" as const,
    defaultBinding: `Mod+${index + 1}`,
  })),
  { id: "dock.tab-last", group: "Panels", label: "Last panel tab", description: "Show the last tab in the panel", surface: "any", defaultBinding: "Mod+9" },

  { id: "window.capture", group: "Capture", label: "Grab the window you are in", description: "Attach the frontmost app's window to this thread, from anywhere on the desktop", surface: "desktop", defaultBinding: "Alt+Shift+S" },

  { id: "appearance.cycle-theme", group: "Appearance", label: "Next theme", description: "Walk the theme list without opening settings", surface: "any", defaultBinding: "Mod+Shift+T" },
  { id: "appearance.larger-text", group: "Appearance", label: "Bigger text", description: "A step up the reading size, which the chrome does not follow", surface: "any", defaultBinding: "Mod+=" },
  { id: "appearance.smaller-text", group: "Appearance", label: "Smaller text", description: "A step down the reading size, which the chrome does not follow", surface: "any", defaultBinding: "Mod+-" },
];

const ACTIONS_BY_ID = new Map(SHORTCUT_ACTIONS.map((action) => [action.id, action]));

export function shortcutAction(id: string): ShortcutAction | undefined {
  return ACTIONS_BY_ID.get(id);
}

/** Which tab `dock.tab-*` names, counting from zero, with -1 for the last one. */
export function dockTabShortcutIndex(actionId: string): number | null {
  if (actionId === "dock.tab-last") return -1;
  const match = /^dock\.tab-([1-8])$/.exec(actionId);
  return match ? Number(match[1]) - 1 : null;
}

/** What each action is bound to now, for the settings list. */
export function shortcutSettings(overrides: ShortcutOverrides): ShortcutSetting[] {
  return SHORTCUT_ACTIONS.map((action) => {
    const override = action.id in overrides ? overrides[action.id] : undefined;
    const binding = override === undefined ? action.defaultBinding : override;
    return { ...action, binding, changed: binding !== action.defaultBinding };
  });
}

/**
 * The bindings the main process matches against. A keystroke belongs to one action, so an action
 * that shares one with an earlier action is left unbound rather than firing both.
 */
export function resolveShortcuts(overrides: ShortcutOverrides): ShortcutBinding[] {
  const taken = new Set<string>();
  const bindings: ShortcutBinding[] = [];
  for (const setting of shortcutSettings(overrides)) {
    if (!setting.binding || taken.has(setting.binding) || shortcutProblem(setting.binding)) continue;
    taken.add(setting.binding);
    bindings.push({ action: setting.id, binding: setting.binding, surface: setting.surface });
  }
  return bindings;
}

const ACCELERATOR_KEYS: Record<string, string> = {
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ArrowUp: "Up",
  ArrowDown: "Down",
  Enter: "Return",
  Escape: "Esc",
};

/**
 * A binding written the way the desktop registers one. Null for a keystroke the desktop cannot hold,
 * which leaves the action unbound rather than claiming the wrong keys.
 */
export function desktopAccelerator(binding: string): string | null {
  const stroke = parseShortcut(binding);
  if (!stroke || shortcutProblem(binding)) return null;
  return [
    ...(stroke.mod ? ["CommandOrControl"] : []),
    ...(stroke.ctrl ? ["Control"] : []),
    ...(stroke.alt ? ["Alt"] : []),
    ...(stroke.shift ? ["Shift"] : []),
    ACCELERATOR_KEYS[stroke.key] ?? stroke.key,
  ].join("+");
}

/** Which action a keystroke asks for on the surface it was pressed. */
export function shortcutFor(bindings: ShortcutBinding[], stroke: Keystroke, surface: ShortcutSurface): ShortcutBinding | undefined {
  const binding = formatShortcut(stroke);
  return bindings.find((candidate) => candidate.binding === binding && (candidate.surface === "any" || candidate.surface === surface));
}

/** Only the bindings that differ from the default are worth keeping. */
export function shortcutOverrides(overrides: ShortcutOverrides): ShortcutOverrides {
  const kept: ShortcutOverrides = {};
  for (const [id, binding] of Object.entries(overrides)) {
    const action = ACTIONS_BY_ID.get(id);
    if (!action || binding === action.defaultBinding) continue;
    kept[id] = binding;
  }
  return kept;
}

/**
 * The overrides after `action` takes `binding`. A keystroke belongs to one action, so whoever held
 * it loses it rather than the two of them fighting over the key.
 */
export function withShortcut(overrides: ShortcutOverrides, action: string, binding: string | null): ShortcutOverrides {
  const next: ShortcutOverrides = { ...overrides };
  if (binding) {
    for (const setting of shortcutSettings(overrides)) {
      if (setting.id !== action && setting.binding === binding) next[setting.id] = null;
    }
  }
  next[action] = binding;
  return shortcutOverrides(next);
}
