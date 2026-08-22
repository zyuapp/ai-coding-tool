/**
 * The type the window draws in: which families, and how big the two things people actually resize.
 * Chrome — the sidebar, tabs, badges, menus — keeps the sizes it was designed at, so a size choice
 * never moves a row height. Only the conversation and the terminal follow the user.
 */

export type Font = {
  id: string;
  label: string;
};

/** The families the app ships a face for, which the window's own chrome and prose are set in. */
export const UI_FONTS: Font[] = [
  { id: "system", label: "System" },
  { id: "inter", label: "Inter" },
  { id: "plex-sans", label: "IBM Plex Sans" },
  { id: "geist", label: "Geist" },
];

/** The families the app ships a face for, which code, diffs, and the terminal are set in. */
export const MONO_FONTS: Font[] = [
  { id: "system", label: "System" },
  { id: "jetbrains-mono", label: "JetBrains Mono" },
  { id: "fira-code", label: "Fira Code" },
  { id: "source-code-pro", label: "Source Code Pro" },
];

export const DEFAULT_UI_FONT = "system";
export const DEFAULT_MONO_FONT = "system";

/**
 * A family the app does not bundle, named rather than listed. The name is narrow on purpose: it is
 * spliced into a CSS font stack, so anything that could close the string is refused outright.
 */
const CUSTOM_FONT = /^installed:([A-Za-z0-9][A-Za-z0-9 ._-]{0,63})$/;

export function customFontId(family: string): string {
  return `installed:${family}`;
}

export function customFontFamily(id: unknown): string | undefined {
  return typeof id === "string" ? CUSTOM_FONT.exec(id)?.[1] : undefined;
}

/** Whether a name could be carried as a custom id at all, which the picker filters its list by. */
export function isNameableFont(family: string): boolean {
  return customFontFamily(customFontId(family)) !== undefined;
}

const UI_BY_ID = new Map(UI_FONTS.map((font) => [font.id, font]));
const MONO_BY_ID = new Map(MONO_FONTS.map((font) => [font.id, font]));

function fontById(known: Map<string, Font>, id: unknown): Font | undefined {
  if (typeof id !== "string") return undefined;
  const family = customFontFamily(id);
  return family ? { id, label: family } : known.get(id);
}

/** A family the app no longer ships reports nothing, so the caller falls back to the system's own. */
export function uiFontById(id: unknown): Font | undefined {
  return fontById(UI_BY_ID, id);
}

export function monoFontById(id: unknown): Font | undefined {
  return fontById(MONO_BY_ID, id);
}

export function uiFontOrDefault(id: unknown): Font {
  return uiFontById(id) ?? UI_BY_ID.get(DEFAULT_UI_FONT)!;
}

export function monoFontOrDefault(id: unknown): Font {
  return monoFontById(id) ?? MONO_BY_ID.get(DEFAULT_MONO_FONT)!;
}

/** A size the user can land on, in px, rather than a rung with a name. */
export type SizeRange = {
  min: number;
  max: number;
  default: number;
  /** The px the four named rungs this once offered drew at, so a stored choice survives the change. */
  legacy: Record<string, number>;
};

export const READING_SIZE: SizeRange = {
  min: 12,
  max: 24,
  default: 15,
  legacy: { small: 13, regular: 15, large: 17, larger: 19 },
};

export const TERMINAL_SIZE: SizeRange = {
  min: 10,
  max: 22,
  default: 12,
  legacy: { small: 11, regular: 12, large: 13, larger: 15 },
};

export function clampSize(range: SizeRange, value: number): number {
  return Math.min(range.max, Math.max(range.min, Math.round(value)));
}

/** A number in range, a rung this once offered, or nothing at all. */
export function sizeById(range: SizeRange, value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value >= range.min && value <= range.max ? Math.round(value) : undefined;
  }
  if (typeof value === "string" && value in range.legacy) return clampSize(range, range.legacy[value]);
  return undefined;
}

export function sizeOrDefault(range: SizeRange, value: unknown): number {
  return sizeById(range, value) ?? range.default;
}

/** The next px up or down. Unlike the theme ring, the ends hold rather than wrap. */
export function stepSize(range: SizeRange, value: unknown, delta: 1 | -1): number {
  return clampSize(range, sizeOrDefault(range, value) + delta);
}
