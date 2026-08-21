/** Whether a theme paints on a dark or a light ground, which native chrome and Mermaid follow. */
export type ThemeVariant = "dark" | "light";

export type Theme = {
  id: string;
  label: string;
  /** The family the picker groups by, so pairs sit together. */
  family: string;
  variant: ThemeVariant;
  /** The theme's --p-bg-0, which the window paints before the renderer has drawn anything. */
  canvas: string;
};

export const THEMES: Theme[] = [
  { id: "claudex-dark", label: "Claudex Dark", family: "Claudex", variant: "dark", canvas: "#0e1117" },
  { id: "claudex-light", label: "Claudex Light", family: "Claudex", variant: "light", canvas: "#faf9f6" },
  { id: "catppuccin-mocha", label: "Catppuccin Mocha", family: "Catppuccin", variant: "dark", canvas: "#11111b" },
  { id: "catppuccin-latte", label: "Catppuccin Latte", family: "Catppuccin", variant: "light", canvas: "#eff1f5" },
  { id: "tokyo-night", label: "Tokyo Night", family: "Tokyo Night", variant: "dark", canvas: "#16161e" },
  { id: "tokyo-night-day", label: "Tokyo Night Day", family: "Tokyo Night", variant: "light", canvas: "#e1e2e7" },
  { id: "gruvbox-dark", label: "Gruvbox Dark", family: "Gruvbox", variant: "dark", canvas: "#1d2021" },
  { id: "gruvbox-light", label: "Gruvbox Light", family: "Gruvbox", variant: "light", canvas: "#fbf1c7" },
];

export const DEFAULT_THEME = "claudex-dark";

const BY_ID = new Map(THEMES.map((entry) => [entry.id, entry]));

/** A theme the app no longer ships reports nothing, so the caller falls back to the default. */
export function themeById(id: unknown): Theme | undefined {
  return typeof id === "string" ? BY_ID.get(id) : undefined;
}

export function themeOrDefault(id: unknown): Theme {
  return themeById(id) ?? BY_ID.get(DEFAULT_THEME)!;
}

/** The families in the order the picker draws them, each with its variants. */
export function themeFamilies(): { family: string; themes: Theme[] }[] {
  const families: { family: string; themes: Theme[] }[] = [];
  for (const entry of THEMES) {
    const group = families.find((item) => item.family === entry.family);
    if (group) group.themes.push(entry);
    else families.push({ family: entry.family, themes: [entry] });
  }
  return families;
}

/** The theme after this one in the list, which the keyboard walks in a ring. */
export function nextTheme(id: unknown): Theme {
  const index = THEMES.findIndex((entry) => entry.id === themeOrDefault(id).id);
  return THEMES[(index + 1) % THEMES.length];
}
