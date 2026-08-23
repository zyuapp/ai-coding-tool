/** Whether a theme paints on a dark or a light ground, which native chrome and Mermaid follow. */
export type ThemeVariant = "dark" | "light";

/** The ground the user asked for. "auto" hands the choice to the system's own appearance. */
export type ThemeMode = ThemeVariant | "auto";

export type Theme = {
  id: string;
  label: string;
  /** The family the picker offers, which holds one theme per variant. */
  family: string;
  variant: ThemeVariant;
  /** The theme's --p-bg-0, which the window paints before the renderer has drawn anything. */
  canvas: string;
};

export const THEMES: Theme[] = [
  { id: "aicodingtool-dark", label: "AI Coding Tool Dark", family: "AI Coding Tool", variant: "dark", canvas: "#0e1117" },
  { id: "aicodingtool-light", label: "AI Coding Tool Light", family: "AI Coding Tool", variant: "light", canvas: "#faf9f6" },
  { id: "catppuccin-mocha", label: "Catppuccin Mocha", family: "Catppuccin", variant: "dark", canvas: "#11111b" },
  { id: "catppuccin-latte", label: "Catppuccin Latte", family: "Catppuccin", variant: "light", canvas: "#eff1f5" },
  { id: "tokyo-night", label: "Tokyo Night", family: "Tokyo Night", variant: "dark", canvas: "#16161e" },
  { id: "tokyo-night-day", label: "Tokyo Night Day", family: "Tokyo Night", variant: "light", canvas: "#e1e2e7" },
  { id: "gruvbox-dark", label: "Gruvbox Dark", family: "Gruvbox", variant: "dark", canvas: "#1d2021" },
  { id: "gruvbox-light", label: "Gruvbox Light", family: "Gruvbox", variant: "light", canvas: "#fbf1c7" },
];

export const DEFAULT_THEME = "aicodingtool-dark";
export const DEFAULT_THEME_MODE: ThemeMode = "dark";

const BY_ID = new Map(THEMES.map((entry) => [entry.id, entry]));

/** A theme the app no longer ships reports nothing, so the caller falls back to the default. */
export function themeById(id: unknown): Theme | undefined {
  return typeof id === "string" ? BY_ID.get(id) : undefined;
}

export function themeOrDefault(id: unknown): Theme {
  return themeById(id) ?? BY_ID.get(DEFAULT_THEME)!;
}

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === "dark" || value === "light" || value === "auto";
}

export function themeModeOrDefault(value: unknown): ThemeMode {
  return isThemeMode(value) ? value : DEFAULT_THEME_MODE;
}

/** The families the picker draws, in the order they were declared. */
export function themeFamilies(): string[] {
  return [...new Set(THEMES.map((entry) => entry.family))];
}

/** Which ground a mode lands on, which only "auto" needs the system's own appearance to answer. */
export function variantFor(mode: ThemeMode, systemDark: boolean): ThemeVariant {
  if (mode === "auto") return systemDark ? "dark" : "light";
  return mode;
}

/**
 * The one theme in a family that paints on this ground. A family that has never heard of the
 * variant, or of the name, falls back to the default's family so the caller always gets a theme.
 */
export function themeFor(family: unknown, variant: ThemeVariant): Theme {
  return THEMES.find((entry) => entry.family === family && entry.variant === variant)
    ?? THEMES.find((entry) => entry.family === themeOrDefault(DEFAULT_THEME).family && entry.variant === variant)!;
}
