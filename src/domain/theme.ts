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
  { id: "abyss", label: "Abyss", family: "Abyss", variant: "dark", canvas: "#001024" },
  { id: "shoal", label: "Shoal", family: "Abyss", variant: "light", canvas: "#f2fafe" },
  { id: "aurora-night", label: "Aurora Night", family: "Aurora", variant: "dark", canvas: "#051423" },
  { id: "aurora-day", label: "Aurora Day", family: "Aurora", variant: "light", canvas: "#f3fafc" },
  { id: "ayu-dark", label: "Ayu Dark", family: "Ayu", variant: "dark", canvas: "#0b0e14" },
  { id: "ayu-light", label: "Ayu Light", family: "Ayu", variant: "light", canvas: "#f8f9fa" },
  { id: "broadsheet-press", label: "Broadsheet Press", family: "Broadsheet", variant: "dark", canvas: "#140c09" },
  { id: "broadsheet-salmon", label: "Broadsheet Salmon", family: "Broadsheet", variant: "light", canvas: "#ffe9db" },
  { id: "catppuccin-mocha", label: "Catppuccin Mocha", family: "Catppuccin", variant: "dark", canvas: "#11111b" },
  { id: "catppuccin-latte", label: "Catppuccin Latte", family: "Catppuccin", variant: "light", canvas: "#eff1f5" },
  { id: "clearwater-deep", label: "Clearwater Deep", family: "Clearwater", variant: "dark", canvas: "#081829" },
  { id: "clearwater-shallows", label: "Clearwater Shallows", family: "Clearwater", variant: "light", canvas: "#f0f8fe" },
  { id: "cyanotype", label: "Cyanotype", family: "Cyanotype", variant: "dark", canvas: "#00172d" },
  { id: "cyanotype-print", label: "Cyanotype Print", family: "Cyanotype", variant: "light", canvas: "#faf7ec" },
  { id: "dracula", label: "Dracula", family: "Dracula", variant: "dark", canvas: "#21222c" },
  { id: "alucard", label: "Alucard", family: "Dracula", variant: "light", canvas: "#fffbeb" },
  { id: "dune-dusk", label: "Dune Dusk", family: "Dune", variant: "dark", canvas: "#1e1710" },
  { id: "dune-noon", label: "Dune Noon", family: "Dune", variant: "light", canvas: "#fbf2df" },
  { id: "ember-dark", label: "Ember Dark", family: "Ember", variant: "dark", canvas: "#150f0d" },
  { id: "ember-light", label: "Ember Light", family: "Ember", variant: "light", canvas: "#fcf6ee" },
  { id: "everforest-dark", label: "Everforest Dark", family: "Everforest", variant: "dark", canvas: "#2d353b" },
  { id: "everforest-light", label: "Everforest Light", family: "Everforest", variant: "light", canvas: "#fdf6e3" },
  { id: "github-dark", label: "GitHub Dark", family: "GitHub", variant: "dark", canvas: "#0d1117" },
  { id: "github-light", label: "GitHub Light", family: "GitHub", variant: "light", canvas: "#f6f8fa" },
  { id: "glacier-crevasse", label: "Glacier Crevasse", family: "Glacier", variant: "dark", canvas: "#00141f" },
  { id: "glacier-ice", label: "Glacier Ice", family: "Glacier", variant: "light", canvas: "#e9f9ff" },
  { id: "graphite", label: "Graphite", family: "Graphite", variant: "dark", canvas: "#121314" },
  { id: "paper", label: "Paper", family: "Graphite", variant: "light", canvas: "#f9fafb" },
  { id: "gruvbox-dark", label: "Gruvbox Dark", family: "Gruvbox", variant: "dark", canvas: "#1d2021" },
  { id: "gruvbox-light", label: "Gruvbox Light", family: "Gruvbox", variant: "light", canvas: "#fbf1c7" },
  { id: "kanagawa-wave", label: "Kanagawa Wave", family: "Kanagawa", variant: "dark", canvas: "#1f1f28" },
  { id: "kanagawa-lotus", label: "Kanagawa Lotus", family: "Kanagawa", variant: "light", canvas: "#f2ecbc" },
  { id: "kintsugi-lacquer", label: "Kintsugi Lacquer", family: "Kintsugi", variant: "dark", canvas: "#0d0b09" },
  { id: "kintsugi-porcelain", label: "Kintsugi Porcelain", family: "Kintsugi", variant: "light", canvas: "#fbf9f3" },
  { id: "klein-blue", label: "Klein Blue", family: "Klein", variant: "dark", canvas: "#000b55" },
  { id: "klein-gallery", label: "Klein Gallery", family: "Klein", variant: "light", canvas: "#fafcff" },
  { id: "lights-out", label: "Lights Out", family: "Lights Out", variant: "dark", canvas: "#000000" },
  { id: "lights-on", label: "Lights On", family: "Lights Out", variant: "light", canvas: "#ffffff" },
  { id: "material-darker", label: "Material Darker", family: "Material", variant: "dark", canvas: "#212121" },
  { id: "material-lighter", label: "Material Lighter", family: "Material", variant: "light", canvas: "#fafafa" },
  { id: "molten", label: "Molten", family: "Molten", variant: "dark", canvas: "#0b0807" },
  { id: "molten-ash", label: "Molten Ash", family: "Molten", variant: "light", canvas: "#f9f6f4" },
  { id: "monokai", label: "Monokai", family: "Monokai", variant: "dark", canvas: "#1e1f1c" },
  { id: "monokai-light", label: "Monokai Light", family: "Monokai", variant: "light", canvas: "#fbf9f2" },
  { id: "moss-dark", label: "Moss Dark", family: "Moss", variant: "dark", canvas: "#101911" },
  { id: "moss-light", label: "Moss Light", family: "Moss", variant: "light", canvas: "#f7f8ed" },
  { id: "neon-dusk", label: "Neon Dusk", family: "Neon Dusk", variant: "dark", canvas: "#0f0a29" },
  { id: "neon-dawn", label: "Neon Dawn", family: "Neon Dusk", variant: "light", canvas: "#f9f7ff" },
  { id: "nier-automata-dark", label: "NieR: Automata Dark", family: "NieR: Automata", variant: "dark", canvas: "#2f2d26" },
  { id: "nier-automata", label: "NieR: Automata", family: "NieR: Automata", variant: "light", canvas: "#ccc8b1" },
  { id: "night-owl", label: "Night Owl", family: "Night Owl", variant: "dark", canvas: "#011627" },
  { id: "light-owl", label: "Light Owl", family: "Night Owl", variant: "light", canvas: "#fbfbfb" },
  { id: "nord", label: "Nord", family: "Nord", variant: "dark", canvas: "#2e3440" },
  { id: "nord-snow", label: "Nord Snow Storm", family: "Nord", variant: "light", canvas: "#eceff4" },
  { id: "one-dark", label: "One Dark", family: "One", variant: "dark", canvas: "#21252b" },
  { id: "one-light", label: "One Light", family: "One", variant: "light", canvas: "#fafafa" },
  { id: "orchid-night", label: "Orchid Night", family: "Orchid", variant: "dark", canvas: "#170f23" },
  { id: "orchid-day", label: "Orchid Day", family: "Orchid", variant: "light", canvas: "#faf6fd" },
  { id: "oxblood", label: "Oxblood", family: "Oxblood", variant: "dark", canvas: "#290509" },
  { id: "oxblood-bone", label: "Oxblood Bone", family: "Oxblood", variant: "light", canvas: "#fcf5ec" },
  { id: "riso-night", label: "Riso Night", family: "Riso", variant: "dark", canvas: "#0a1320" },
  { id: "riso-paper", label: "Riso Paper", family: "Riso", variant: "light", canvas: "#faf6ea" },
  { id: "rose-pine", label: "Rosé Pine", family: "Rosé Pine", variant: "dark", canvas: "#191724" },
  { id: "rose-pine-dawn", label: "Rosé Pine Dawn", family: "Rosé Pine", variant: "light", canvas: "#faf4ed" },
  { id: "sakura-night", label: "Sakura Night", family: "Sakura", variant: "dark", canvas: "#1c0f17" },
  { id: "sakura-bloom", label: "Sakura Bloom", family: "Sakura", variant: "light", canvas: "#fff4f6" },
  { id: "sodium-night", label: "Sodium Night", family: "Sodium", variant: "dark", canvas: "#0b1015" },
  { id: "sodium-fog", label: "Sodium Fog", family: "Sodium", variant: "light", canvas: "#f0f4f7" },
  { id: "solarized-dark", label: "Solarized Dark", family: "Solarized", variant: "dark", canvas: "#002b36" },
  { id: "solarized-light", label: "Solarized Light", family: "Solarized", variant: "light", canvas: "#fdf6e3" },
  { id: "terracotta-kiln", label: "Terracotta Kiln", family: "Terracotta", variant: "dark", canvas: "#2b0f05" },
  { id: "terracotta-adobe", label: "Terracotta Adobe", family: "Terracotta", variant: "light", canvas: "#fef0e2" },
  { id: "tokyo-night", label: "Tokyo Night", family: "Tokyo Night", variant: "dark", canvas: "#16161e" },
  { id: "tokyo-night-day", label: "Tokyo Night Day", family: "Tokyo Night", variant: "light", canvas: "#e1e2e7" },
  { id: "verdigris-dark", label: "Verdigris Dark", family: "Verdigris", variant: "dark", canvas: "#061a1a" },
  { id: "verdigris-light", label: "Verdigris Light", family: "Verdigris", variant: "light", canvas: "#f0f9f8" },
  { id: "vitesse-dark", label: "Vitesse Dark", family: "Vitesse", variant: "dark", canvas: "#121212" },
  { id: "vitesse-light", label: "Vitesse Light", family: "Vitesse", variant: "light", canvas: "#ffffff" },
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
