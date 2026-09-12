import assert from "node:assert/strict";
import { test } from "vitest";
import { defaultMobileTheme, MOBILE_THEME_KEY, readStoredTheme, resolveMobileTheme, writeStoredTheme } from "../../src/mobile/theme.ts";

function store() {
  const held = new Map<string, string>();
  return { getItem: (key: string) => held.get(key) ?? null, setItem: (key: string, value: string) => { held.set(key, value); }, removeItem: (key: string) => { held.delete(key); } };
}

test("the phone wears the desktop's face, and on auto its own", () => {
  const theme = { dark: "nord", light: "nord-snow", mode: "light" as const };
  assert.equal(resolveMobileTheme(theme, true).id, "nord-snow", "a desktop on light stays light in the dark");
  assert.equal(resolveMobileTheme({ ...theme, mode: "dark" }, false).id, "nord");
  assert.equal(resolveMobileTheme({ ...theme, mode: "auto" }, true).id, "nord");
  assert.equal(resolveMobileTheme({ ...theme, mode: "auto" }, false).id, "nord-snow");
  assert.equal(resolveMobileTheme({ dark: "no-such-theme", light: "nor-this", mode: "dark" }, true).id, "aicodingtool-dark", "a theme this page has never heard of falls back");
});

test("the last theme seen is kept for the next visit, and garbage is not believed", () => {
  const held = store();
  assert.equal(readStoredTheme(held), null);
  writeStoredTheme(held, { dark: "dracula", light: "alucard", mode: "auto" });
  assert.deepEqual(readStoredTheme(held), { dark: "dracula", light: "alucard", mode: "auto" });
  held.setItem(MOBILE_THEME_KEY, JSON.stringify({ dark: "dracula", light: "alucard", mode: "sideways" }));
  assert.equal(readStoredTheme(held), null);
  held.setItem(MOBILE_THEME_KEY, "{not json");
  assert.equal(readStoredTheme(held), null);
  assert.deepEqual(defaultMobileTheme(), { dark: "aicodingtool-dark", light: "aicodingtool-light", mode: "auto" });
});
