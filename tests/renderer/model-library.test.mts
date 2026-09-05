import assert from "node:assert/strict";
import { test } from "vitest";
import React, { act } from "react";
import { mount, query } from "../support/renderer-dom.mts";
import { readViewPreferences } from "../../src/application/view-preferences.ts";
import type { AgentModel } from "../../src/domain/agent-engine.ts";
const { ComposerSettings, EVERY_ENGINE_READY } = await import("../../src/renderer/components/ComposerSettings.tsx");

test("the library filters providers, searches globally, pins without choosing, and selects by keyboard", async () => {
  const selected: AgentModel[] = [];
  const pinned: Array<[AgentModel, boolean]> = [];
  const props = {
    mode: "confirm" as const, engine: "codex" as const, engineLabel: "Codex", engineLocked: false,
    engineAccess: EVERY_ENGINE_READY, model: "gpt-6-astra" as const, effort: "medium" as const,
    favoriteModels: ["gpt-6-astra"] as AgentModel[],
    onModelFavorite: (model: AgentModel, favorite: boolean) => { pinned.push([model, favorite]); },
    onModelChange: (_engine: string, model: AgentModel) => { selected.push(model); },
    onModeChange() {}, onEffortChange() {}, onEngineRead() {}, onSignIn() {},
  };
  const view = await mount(React.createElement(ComposerSettings, props));
  const menu = view.container.querySelectorAll(".setting-menu")[1]!;
  await act(async () => { query<HTMLElement>(menu, "summary").click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.equal(query(menu, ".model-choice strong").textContent, "Astra");
  assert.equal(menu.querySelectorAll(".model-choice").length, 1);
  const input = query<HTMLInputElement>(menu, "input");
  assert.equal(document.activeElement, input);
  await act(async () => { query<HTMLButtonElement>(menu, '[aria-label="Unpin Astra"]').click(); });
  assert.deepEqual(pinned, [["gpt-6-astra", false]]);
  assert.deepEqual(selected, []);
  await view.render(React.createElement(ComposerSettings, { ...props, favoriteModels: [] }));
  assert.match(query(menu, ".model-empty").textContent!, /Pin models/);
  await act(async () => {
    [...menu.querySelectorAll<HTMLButtonElement>(".model-provider-rail button")].find((button) => button.textContent?.includes("Claude"))!.click();
  });
  assert.deepEqual([...menu.querySelectorAll(".model-choice strong")].map((node) => node.textContent), ["Fable", "Opus", "Sonnet", "Haiku"]);
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, "sol");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  assert.deepEqual([...menu.querySelectorAll(".model-choice strong")].map((node) => node.textContent), ["Sol"]);
  await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); });
  assert.equal(document.activeElement, query(menu, ".model-choice"));
  await act(async () => { input.focus(); input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.deepEqual(selected, ["gpt-5.6-sol"]);
  assert.equal((menu as HTMLDetailsElement).open, false);
  await view.unmount();
});

test("saved model favorites discard obsolete IDs and duplicates", () => {
  const preferences = readViewPreferences({ getItem: () => JSON.stringify({ favoriteModels: ["opus", "obsolete", 7, "opus", "gpt-6-astra"] }), setItem() {} });
  assert.deepEqual(preferences.favoriteModels, ["opus", "gpt-6-astra"]);
  assert.deepEqual(readViewPreferences({ getItem: () => '{"favoriteModels":false}', setItem() {} }).favoriteModels, []);
});
