import assert from "node:assert/strict";
import { test } from "vitest";
import React, { act } from "react";
import { mount, query } from "../support/renderer-dom.mts";
import { readViewPreferences } from "../../src/application/view-preferences.ts";
import { BUILT_IN_MODELS, engineCatalog, modelDelegable, type AgentModel } from "../../src/domain/agent-engine.ts";
const { ModelCatalogProvider } = await import("../../src/renderer/model-catalog.ts");
const { ComposerSettings, EVERY_ENGINE_READY, ModelMenu } = await import("../../src/renderer/components/ComposerSettings.tsx");

test("the library filters providers, searches globally, pins without choosing, and selects by keyboard", async () => {
  const selected: AgentModel[] = [];
  const pinned: Array<[AgentModel, boolean]> = [];
  const props = {
    mode: "confirm" as const, engine: "codex" as const, engineLabel: "Codex", engineLocked: false,
    engineAccess: EVERY_ENGINE_READY, model: "gpt-6-astra" as const, effort: "medium" as const,
    favoriteModels: ["gpt-6-astra"] as AgentModel[],
    onModelFavorite: (model: AgentModel, favorite: boolean) => { pinned.push([model, favorite]); },
    onModelChange: (_engine: string, model: AgentModel) => { selected.push(model); },
    onModeChange() {}, onEffortChange() {}, fastMode: false, onFastModeChange() {}, onEngineRead() {}, onSignIn() {},
  };
  const view = await mount(React.createElement(ComposerSettings, props));
  const menu = view.container.querySelectorAll(".setting-menu")[1]!;
  await act(async () => { query<HTMLElement>(menu, "summary").click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.equal(query(menu, ".model-choice strong").textContent, "Astra");
  assert.equal(menu.querySelectorAll(".model-choice").length, 1);
  const input = query<HTMLInputElement>(menu, "input");
  assert.equal(document.activeElement, input);
  assert.equal(query<HTMLElement>(menu, '[aria-label="Unpin Astra"]').dataset.tip, "Unpin from Favorites");
  await act(async () => { query<HTMLButtonElement>(menu, '[aria-label="Unpin Astra"]').click(); });
  assert.deepEqual(pinned, [["gpt-6-astra", false]]);
  assert.deepEqual(selected, []);
  await view.render(React.createElement(ComposerSettings, { ...props, favoriteModels: [] }));
  assert.match(query(menu, ".model-empty").textContent!, /Pin models/);
  await act(async () => {
    [...menu.querySelectorAll<HTMLButtonElement>(".model-provider-rail button")].find((button) => button.textContent?.includes("Claude"))!.click();
  });
  assert.deepEqual([...menu.querySelectorAll("[role=group]")].map((group) => group.getAttribute("aria-label")), ["Claude"]);
  assert.ok(menu.querySelectorAll(".model-choice").length > 0);
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, "sol");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  assert.deepEqual([...menu.querySelectorAll(".model-choice strong")].map((node) => node.textContent), ["Sol"]);
  await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); });
  assert.equal(document.activeElement, query(menu, ".model-choice"));
  await act(async () => { input.focus(); input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.deepEqual(selected, ["gpt-6.1-sol"]);
  assert.equal((menu as HTMLDetailsElement).open, false);
  await view.unmount();
});

test("saved model favorites discard malformed IDs and duplicates, and keep one no engine offers right now", () => {
  const preferences = readViewPreferences({ getItem: () => JSON.stringify({ favoriteModels: ["opus", "obsolete", 7, "two words", "opus", "gpt-6-astra", "gpt-5.6-sol"] }), setItem() {} });
  assert.deepEqual(preferences.favoriteModels, ["opus", "obsolete", "gpt-6-astra", "gpt-6.1-sol"]);
  assert.deepEqual(readViewPreferences({ getItem: () => '{"favoriteModels":false}', setItem() {} }).favoriteModels, []);
});

test("the Codex speed toggle follows effort and dispatches both speed changes", async () => {
  const selected: boolean[] = [];
  const props = {
    mode: "confirm" as const, engine: "codex" as const, engineLabel: "Codex", engineLocked: true,
    engineAccess: EVERY_ENGINE_READY, model: "gpt-6.1-sol" as const, effort: "high" as const,
    fastMode: false, onFastModeChange: (fastMode: boolean) => { selected.push(fastMode); },
    onModeChange() {}, onModelChange() {}, onEffortChange() {}, onEngineRead() {}, onSignIn() {},
  };
  const view = await mount(React.createElement(ComposerSettings, props));
  const toggle = query<HTMLButtonElement>(view.container, 'button[aria-label="Fast mode"]');
  assert.equal(toggle.parentElement?.lastElementChild, toggle);
  assert.ok(toggle.previousElementSibling?.querySelector('summary[aria-label^="Model and effort: Sol, "]'));
  assert.equal(toggle.getAttribute("aria-pressed"), "false");
  assert.match(toggle.dataset.tip ?? "", /use more of your plan/);
  assert.equal(toggle.title, "");
  await act(async () => { toggle.click(); });
  assert.deepEqual(selected, [true]);
  assert.equal(toggle.textContent, "Fast", "an idle fast mode still names itself");
  assert.equal(toggle.querySelector("svg")?.getAttribute("fill"), "none");
  await view.render(React.createElement(ComposerSettings, { ...props, fastMode: true }));
  assert.equal(toggle.getAttribute("aria-pressed"), "true");
  assert.equal(toggle.querySelector("svg")?.getAttribute("fill"), "currentColor", "an active fast mode fills its bolt");
  assert.equal(toggle.getAttribute("aria-label"), "Fast mode");
  await act(async () => { toggle.click(); });
  assert.deepEqual(selected, [true, false]);
  await view.render(React.createElement(ComposerSettings, { ...props, engine: "claude", engineLabel: "Claude", model: "opus" }));
  assert.equal(view.container.querySelector('button[aria-label="Fast mode"]'), null);
  assert.equal(view.container.querySelector(".setting-menu.danger"), null);
  await view.render(React.createElement(ComposerSettings, { ...props, mode: "bypass" }));
  assert.equal(query(view.container, ".setting-menu.danger summary").getAttribute("aria-label"), "Permission mode: Bypass", "bypass is marked on the chip, not only inside its menu");
  await view.unmount();
});

test("a library narrowed to some models offers only those, in its counts as well", async () => {
  const props = {
    engine: "claude" as const, engineLocked: false, engineAccess: EVERY_ENGINE_READY, model: "opus" as const,
    onChange() {}, onOpen() {}, onSignIn() {},
  };
  const view = await mount(React.createElement(ModelMenu, { ...props, models: (model: string) => modelDelegable(BUILT_IN_MODELS, model) }));
  await act(async () => { query<HTMLElement>(view.container, "summary").click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
  const names = () => [...view.container.querySelectorAll(".model-choice strong")].map((node) => node.textContent);
  assert.ok(names().includes("Sonnet"));
  assert.ok(!names().includes("Haiku"), "Haiku cannot run a coordinator's threads, so it is not offered");
  const claude = [...view.container.querySelectorAll<HTMLButtonElement>(".model-provider-rail button")].find((button) => button.textContent?.includes("Claude"))!;
  assert.match(claude.textContent!, /Claude3$/);

  await view.render(React.createElement(ModelMenu, props));
  assert.ok(names().includes("Haiku"), "the composer's own library still offers every model");
  await view.unmount();
});

test("the library lists what the catalogue on screen holds, and a model it does not hold is named by its id", async () => {
  const catalog = engineCatalog({ codex: { access: "ready", catalog: [
    { id: "openai/gpt-9", label: "GPT-9", description: "Named by the engine", contextWindow: 400_000, efforts: [{ id: "high", label: "High" }, { id: "low", label: "Low" }] },
  ] } });
  const chosen: AgentModel[] = [];
  const props = {
    engine: "codex" as const, engineLocked: false, engineAccess: EVERY_ENGINE_READY, model: "openai/gpt-9" as AgentModel,
    effort: { value: "max" as const, onChange() {} },
    onChange: (_engine: string, model: AgentModel) => { chosen.push(model); }, onOpen() {}, onSignIn() {},
  };
  const menu = (model: AgentModel) => React.createElement(ModelCatalogProvider, { value: catalog }, React.createElement(ModelMenu, { ...props, model }));
  const view = await mount(menu("openai/gpt-9"));
  assert.equal(query(view.container, "summary").getAttribute("aria-label"), "Model and effort: GPT-9, High", "an effort the model does not take shows as the nearest one it does");
  await act(async () => { query<HTMLElement>(view.container, "summary").click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
  const names = [...view.container.querySelectorAll(".model-choice strong")].map((node) => node.textContent);
  assert.ok(names.includes("GPT-9"));
  assert.ok(names.includes("Opus"), "an engine that names no models keeps the built-in ones");
  assert.ok(!names.includes("Sol"), "an engine that names its own models replaces the built-in ones");
  const gpt9 = [...view.container.querySelectorAll<HTMLButtonElement>(".model-choice")].find((button) => button.textContent?.includes("GPT-9"))!;
  await act(async () => { gpt9.click(); });
  assert.deepEqual(chosen, ["openai/gpt-9"]);

  await view.render(menu("openai/gone"));
  assert.equal(query(view.container, "summary").getAttribute("aria-label"), "Model: openai/gone");
  await view.unmount();
});
