import type { MobileTheme } from "../contracts/mobile";
import { DEFAULT_THEME, themeFor, themeOrDefault, type Theme } from "../domain/theme";
import type { CredentialStore } from "./client/storage";

/** The desktop's theme as it was last seen, so a page paints the right ground before the Mac answers. */
export const MOBILE_THEME_KEY = "aicodingtool.mobile.theme";

export function defaultMobileTheme(): MobileTheme {
  const family = themeOrDefault(DEFAULT_THEME).family;
  return { dark: themeFor(family, "dark").id, light: themeFor(family, "light").id, mode: "auto" };
}

/**
 * Which face the phone wears: the desktop's own ground when it has chosen one, and the phone's own
 * appearance when the desktop follows the system, since the phone is on its own ground.
 */
export function resolveMobileTheme(theme: MobileTheme, systemDark: boolean): Theme {
  const dark = theme.mode === "auto" ? systemDark : theme.mode === "dark";
  return themeOrDefault(dark ? theme.dark : theme.light);
}

export function readStoredTheme(store: CredentialStore): MobileTheme | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(store.getItem(MOBILE_THEME_KEY) ?? "null");
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const { dark, light, mode } = parsed as Record<string, unknown>;
  if (typeof dark !== "string" || typeof light !== "string") return null;
  if (mode !== "dark" && mode !== "light" && mode !== "auto") return null;
  return { dark, light, mode };
}

export function writeStoredTheme(store: CredentialStore, theme: MobileTheme): void {
  store.setItem(MOBILE_THEME_KEY, JSON.stringify(theme));
}

/** The root attribute does the painting; the browser's own chrome reads the two hints beside it. */
export function paintMobileTheme(chosen: Theme): void {
  document.documentElement.dataset.theme = chosen.id;
  document.documentElement.style.colorScheme = chosen.variant;
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    meta.removeAttribute("media");
    meta.content = chosen.canvas;
  }
}
