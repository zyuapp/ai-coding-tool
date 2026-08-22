/**
 * The type the window draws in: which families, and how big the two things people actually resize.
 * Chrome — the sidebar, tabs, badges, menus — keeps the sizes it was designed at, so a size choice
 * never moves a row height. Only the conversation and the terminal follow the user.
 */

export type Font = {
  id: string;
  label: string;
};

/** The families the window's own chrome and prose are set in. */
export const UI_FONTS: Font[] = [
  { id: "system", label: "System" },
  { id: "inter", label: "Inter" },
  { id: "plex-sans", label: "IBM Plex Sans" },
  { id: "geist", label: "Geist" },
];

/** The families code, diffs, and the terminal are set in. */
export const MONO_FONTS: Font[] = [
  { id: "system", label: "System" },
  { id: "jetbrains-mono", label: "JetBrains Mono" },
  { id: "fira-code", label: "Fira Code" },
  { id: "source-code-pro", label: "Source Code Pro" },
];

export const DEFAULT_UI_FONT = "system";
export const DEFAULT_MONO_FONT = "system";

export type TextSize = {
  id: string;
  label: string;
  /** What the button group prints, which has room for a letter and no more. */
  short: string;
};

/** The four steps both size choices walk, smallest first. */
export const TEXT_SIZES: TextSize[] = [
  { id: "small", label: "Small", short: "S" },
  { id: "regular", label: "Regular", short: "M" },
  { id: "large", label: "Large", short: "L" },
  { id: "larger", label: "Larger", short: "XL" },
];

export const DEFAULT_TEXT_SIZE = "regular";

const UI_BY_ID = new Map(UI_FONTS.map((font) => [font.id, font]));
const MONO_BY_ID = new Map(MONO_FONTS.map((font) => [font.id, font]));
const SIZE_BY_ID = new Map(TEXT_SIZES.map((size) => [size.id, size]));

/** A family the app no longer ships reports nothing, so the caller falls back to the system's own. */
export function uiFontById(id: unknown): Font | undefined {
  return typeof id === "string" ? UI_BY_ID.get(id) : undefined;
}

export function monoFontById(id: unknown): Font | undefined {
  return typeof id === "string" ? MONO_BY_ID.get(id) : undefined;
}

export function textSizeById(id: unknown): TextSize | undefined {
  return typeof id === "string" ? SIZE_BY_ID.get(id) : undefined;
}

export function uiFontOrDefault(id: unknown): Font {
  return uiFontById(id) ?? UI_BY_ID.get(DEFAULT_UI_FONT)!;
}

export function monoFontOrDefault(id: unknown): Font {
  return monoFontById(id) ?? MONO_BY_ID.get(DEFAULT_MONO_FONT)!;
}

export function textSizeOrDefault(id: unknown): TextSize {
  return textSizeById(id) ?? SIZE_BY_ID.get(DEFAULT_TEXT_SIZE)!;
}

/** The step above or below this one. Unlike the theme ring, the ends hold rather than wrap. */
export function stepTextSize(id: unknown, delta: 1 | -1): TextSize {
  const index = TEXT_SIZES.findIndex((size) => size.id === textSizeOrDefault(id).id);
  return TEXT_SIZES[Math.min(TEXT_SIZES.length - 1, Math.max(0, index + delta))];
}
