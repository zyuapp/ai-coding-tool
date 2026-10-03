import assert from "node:assert/strict";
import { test } from "vitest";
import { SETTINGS_CONTROLS, SETTINGS_JUMP_OPTIONS, settingControl } from "../../src/domain/settings-catalog.ts";
import { rankSettingsJumps } from "../../src/domain/settings-jump.ts";
import { SETTINGS_SECTIONS } from "../../src/domain/settings-section.ts";
import { SHORTCUT_ACTIONS } from "../../src/domain/shortcuts.ts";

test("the panel opens on threads alone, so an empty query offers no settings", () => {
  assert.deepEqual(rankSettingsJumps(""), []);
  assert.deepEqual(rankSettingsJumps("   "), []);
});

test("every page, control, and shortcut is offered, each under the page it sits on", () => {
  assert.equal(SETTINGS_JUMP_OPTIONS.length, SETTINGS_SECTIONS.length + SETTINGS_CONTROLS.length + SHORTCUT_ACTIONS.length);
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
  assert.deepEqual(rankSettingsJumps("trash").map((option) => option.section), ["archive"]);
});

test("a group's name beats the keyword that names its page", () => {
  assert.deepEqual(rankSettingsJumps("tailscale").map((option) => option.settingId), ["phone.tailscale", null]);
});

test("every group a page draws can be found by its heading", () => {
  for (const [query, id] of [["installed engines", "engines.installed"], ["platform setup", "computer-use.platform"], ["linux runtime", "computer-use.linux-runtime"]]) {
    assert.equal(rankSettingsJumps(query)[0]?.settingId, id, query);
  }
});

test("every word of a longer query has to land", () => {
  assert.deepEqual(rankSettingsJumps("text size").map((option) => option.settingId), [null, "appearance.reading-size", "appearance.terminal-size"]);
  assert.deepEqual(rankSettingsJumps("text purple"), []);
});

test("a shortcut is found by its name and lands on its own row", () => {
  const [deny] = rankSettingsJumps("deny");
  assert.deepEqual(deny && { section: deny.section, settingId: deny.settingId, page: deny.page }, { section: "shortcuts", settingId: "shortcut.run.deny", page: "Shortcuts" });
});

test("the list is cut to the rows the panel draws", () => {
  assert.equal(rankSettingsJumps("e", 3).length, 3);
});

test("a name nothing answers offers nothing", () => {
  assert.deepEqual(rankSettingsJumps("kubernetes"), []);
});
