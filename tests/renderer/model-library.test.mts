import assert from "node:assert/strict";
import { test } from "vitest";
import React, { act } from "react";
import { mount, query } from "../support/renderer-dom.mts";
import { readViewPreferences } from "../../src/application/view-preferences.ts";
import { BUILT_IN_MODELS, engineCatalog, modelDelegable, type AgentEngine, type AgentModel } from "../../src/domain/agent-engine.ts";
const { ModelCatalogProvider } = await import("../../src/renderer/model-catalog.ts");
const { ComposerSettings, ModelMenu } = await import("../../src/renderer/components/ComposerSettings.tsx");
const { EVERY_ENGINE_READY } = await import("../../src/domain/model-library.ts");

test("the library filters providers, searches globally, pins without choosing, and selects by keyboard", async () => {
  const selected: AgentModel[] = [];
  const pinned: Array<[AgentEngine, AgentModel, boolean]> = [];
  const props = {
    mode: "confirm" as const, engine: "codex" as const, engineLabel: "Codex", engineLocked: false,
    engineAccess: EVERY_ENGINE_READY, model: "gpt-6-astra" as const, effort: "medium" as const,
    favoriteModels: [{ engine: "codex" as const, model: "gpt-6-astra" }],
    onModelFavorite: (engine: AgentEngine, model: AgentModel, favorite: boolean) => { pinned.push([engine, model, favorite]); },
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
  assert.deepEqual(pinned, [["codex", "gpt-6-astra", false]]);
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
  const preferences = readViewPreferences({ getItem: () => JSON.stringify({ favoriteModels: ["opus", "obsolete", 7, "two words", "opus", "gpt-6-astra", "gpt-5.6-sol", { engine: "opencode", model: "opus" }, { engine: "galaxy", model: "opus" }, { model: "sonnet" }] }), setItem() {} });
  assert.deepEqual(preferences.favoriteModels, [
    { engine: "claude", model: "opus" },
    { engine: "opencode", model: "obsolete" },
    { engine: "codex", model: "gpt-6-astra" },
    { engine: "codex", model: "gpt-6.1-sol" },
    { engine: "opencode", model: "opus" },
    { engine: "claude", model: "sonnet" },
  ], "a bare id lands on the engine that ships it, else on the engine that names its own models");
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
  const view = await mount(React.createElement(ModelMenu, { ...props, models: (engine: AgentEngine, model: string) => modelDelegable(BUILT_IN_MODELS, engine, model) }));
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

test("an engine that runs many providers' models lists them under each provider, says what is wrong once, and offers only its own modes", async () => {
  const spec = (id: string, label: string, provider: string) => ({ id, label, description: id.slice(id.indexOf("/") + 1), provider, contextWindow: 1, efforts: [] });
  const catalog = engineCatalog({ opencode: { access: "ready", catalog: [spec("openrouter/z-ai/glm-5.3-flash", "GLM-5.3-Flash", "OpenRouter"), spec("openrouter/qwen/qwen-4", "Qwen 4", "OpenRouter"), spec("opencode-go/glm-5.3", "GLM-5.3", "OpenCode Go")] } });
  const chosen: string[] = [];
  const props = {
    mode: "allow-edits" as const, engine: "opencode" as const, engineLabel: "OpenCode", engineLocked: true,
    engineAccess: { ...EVERY_ENGINE_READY, opencode: { access: "ready" as const, version: "2.2.5", required: "2.3.0" } }, model: "openrouter/z-ai/glm-5.3-flash" as AgentModel, effort: "high" as const,
    onModelChange: (_engine: string, model: string) => { chosen.push(model); },
    onModeChange() {}, onEffortChange() {}, fastMode: false, onFastModeChange() {}, onEngineRead() {}, onSignIn() {},
  };
  const view = await mount(React.createElement(ModelCatalogProvider, { value: catalog }, React.createElement(ComposerSettings, props)));
  const chips = [...view.container.querySelectorAll("summary")].map((node) => node.getAttribute("aria-label"));
  assert.ok(chips.includes("Model: GLM-5.3-Flash"));
  const mode = [...view.container.querySelectorAll<HTMLElement>("summary")].find((node) => node.getAttribute("aria-label")?.startsWith("Permission mode"))!;
  await act(async () => { mode.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
  const modes = [...view.container.querySelectorAll(".setting-option strong")].map((node) => node.textContent);
  assert.ok(!modes.includes("Auto"), "Auto is not offered on an engine with no reviewer to stand on");
  assert.ok(modes.includes("Edits"));
  await act(async () => { mode.click(); });

  const model = [...view.container.querySelectorAll<HTMLElement>("summary")].find((node) => node.getAttribute("aria-label")?.startsWith("Model"))!;
  await act(async () => { model.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
  await act(async () => { [...view.container.querySelectorAll<HTMLButtonElement>(".model-provider-rail button")].find((node) => node.textContent?.includes("All models"))!.click(); });
  assert.equal(view.container.querySelectorAll(".model-results .setting-readiness").length, 1, "an engine behind the app says so once, not under every provider");
  await act(async () => { [...view.container.querySelectorAll<HTMLButtonElement>(".model-provider-rail button")].find((node) => node.textContent?.includes("OpenRouter"))!.click(); });
  const rail = [...view.container.querySelectorAll(".model-provider-rail button")].map((node) => node.textContent);
  assert.ok(rail.some((text) => text?.startsWith("O") && text.includes("OpenRouter2")), `the rail lists OpenRouter: ${rail.join("|")}`);
  assert.ok(rail.some((text) => text?.includes("OpenCode Go1")));
  assert.equal(query(view.container, ".model-results-heading span").textContent, "OpenRouter", "a locked thread opens on the provider of its model");
  await act(async () => { [...view.container.querySelectorAll<HTMLButtonElement>(".model-provider-rail button")].find((node) => node.textContent?.includes("OpenCode Go"))!.click(); });
  assert.deepEqual([...view.container.querySelectorAll(".model-choice strong")].map((node) => node.textContent), ["GLM-5.3"]);
  await act(async () => { query<HTMLButtonElement>(view.container, ".model-choice").click(); });
  assert.deepEqual(chosen, ["opencode-go/glm-5.3"]);
  await view.unmount();
});

test("a thread on a model its provider no longer lists opens the library on its engine's first provider", async () => {
  const spec = (id: string, provider: string) => ({ id, label: id, description: id, provider, contextWindow: 1, efforts: [] });
  const catalog = engineCatalog({ opencode: { access: "ready", catalog: [spec("openrouter/a", "OpenRouter"), spec("opencode-go/b", "OpenCode Go")] } });
  const props = { engine: "opencode" as const, engineLocked: true, engineAccess: EVERY_ENGINE_READY, model: "gone/model" as AgentModel, onChange() {}, onOpen() {}, onSignIn() {} };
  const view = await mount(React.createElement(ModelCatalogProvider, { value: catalog }, React.createElement(ModelMenu, props)));
  await act(async () => { query<HTMLElement>(view.container, "summary").click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.equal(query(view.container, ".model-results-heading span").textContent, "OpenRouter");
  assert.equal(view.container.querySelectorAll(".model-choice").length, 1);
  await view.unmount();
});
