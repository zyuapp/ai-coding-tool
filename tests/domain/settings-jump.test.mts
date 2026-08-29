import assert from "node:assert/strict";
import { test } from "vitest";
import { SETTINGS_CONTROLS, SETTINGS_JUMP_OPTIONS, SETTINGS_PAGE_LABELS, settingControl } from "../../src/domain/settings-catalog.ts";
import { rankSettingsJumps } from "../../src/domain/settings-jump.ts";
import { SETTINGS_SECTIONS } from "../../src/domain/settings-section.ts";

test("the panel opens on threads alone, so an empty query offers no settings", () => {
  assert.deepEqual(rankSettingsJumps(""), []);
  assert.deepEqual(rankSettingsJumps("   "), []);
});

test("every page and every control is offered, each control under the page it sits on", () => {
  assert.equal(SETTINGS_JUMP_OPTIONS.length, SETTINGS_SECTIONS.length + SETTINGS_CONTROLS.length);
  const control = SETTINGS_JUMP_OPTIONS.find((option) => option.settingId === "appearance.ui-font");
  assert.deepEqual(control, {
    id: "settings:appearance.ui-font",
    section: "appearance",
    settingId: "appearance.ui-font",
    title: "Interface",
    page: "Appearance",
    keywords: settingControl("appearance.ui-font").keywords,
  });
});

test("a page beats a control of the same rank, and a name beats a keyword", () => {
  assert.deepEqual(rankSettingsJumps("browser").map((option) => option.title), ["Browser", "Browser use", "Claude in Chrome"]);
  const fonts = rankSettingsJumps("font").map((option) => option.settingId);
  assert.deepEqual(fonts, [null, "appearance.ui-font", "appearance.mono-font", "appearance.reading-size", "appearance.terminal-size"],
    "nothing is named 'font', so the page and the controls tagged with it answer in catalogue order");
});

test("a keyword reaches a page and a control that their names do not", () => {
  assert.deepEqual(rankSettingsJumps("cli").map((option) => option.settingId).slice(0, 2), [null, "general.cli"]);
  assert.deepEqual(rankSettingsJumps("tailscale").map((option) => option.section), ["phone"]);
});

test("the list is cut to the rows the panel draws", () => {
  assert.equal(rankSettingsJumps("e", 3).length, 3);
});

test("a name nothing answers offers nothing", () => {
  assert.deepEqual(rankSettingsJumps("kubernetes"), []);
});

test("every page has a name and every control belongs to a page", () => {
  for (const section of SETTINGS_SECTIONS) assert.ok(SETTINGS_PAGE_LABELS[section], `${section} has no name`);
  for (const control of SETTINGS_CONTROLS) assert.ok(SETTINGS_SECTIONS.includes(control.section));
});
