import assert from "node:assert/strict";
import { test } from "vitest";
import { BUILT_IN_MODELS, engineCatalog, engineStatusLine, engineStatusWord, offeredPolicies, type EngineStatus, type ModelSpec } from "../../src/domain/agent-engine.js";
import { EVERY_ENGINE_READY, modelLibrary } from "../../src/domain/model-library.js";

const spec = (id: string, label: string, provider: string): ModelSpec => ({ id, label, description: `${label} by ${provider}`, provider, contextWindow: 1, efforts: [] });
const status: EngineStatus = { opencode: { access: "ready", catalog: [spec("openrouter/qwen-4", "Qwen 4", "OpenRouter"), spec("anthropic/opus", "Opus", "Anthropic"), spec("openrouter/glm-5", "GLM 5", "OpenRouter")] } };
const catalog = engineCatalog(status);

test("the library heads an engine's models by provider, keeping the first heading's place", () => {
  const library = modelLibrary(catalog, EVERY_ENGINE_READY, { engine: "claude", locked: false });
  assert.deepEqual(library.available.map((group) => [group.key, group.label, group.first]), [
    ["claude", "Claude", true], ["codex", "Codex", true], ["opencode:OpenRouter", "OpenRouter", true], ["opencode:Anthropic", "Anthropic", false],
  ]);
  assert.deepEqual(library.available[2]!.models.map((model) => model.id), ["openrouter/qwen-4", "openrouter/glm-5"]);
  assert.ok(library.available.every((group) => group.selectable && !group.locked && !group.hint));
});

test("a settled thread's other engines are listed but locked, and only their first heading says a new thread reaches them", () => {
  const library = modelLibrary(catalog, EVERY_ENGINE_READY, { engine: "opencode", locked: true });
  assert.deepEqual(library.available.map((group) => [group.key, group.locked, group.selectable, group.hint?.kind]), [
    ["claude", true, false, "new-thread"], ["codex", true, false, "new-thread"], ["opencode:OpenRouter", false, true, undefined], ["opencode:Anthropic", false, true, undefined],
  ]);
});

test("what stands in an engine's way is said once, on its first heading, and an engine that cannot run cannot be picked", () => {
  const access = { ...EVERY_ENGINE_READY, claude: { access: "signed-out" as const }, codex: { access: "missing" as const, fix: "brew install --cask codex" }, opencode: { access: "ready" as const, version: "2.2.5", required: "2.3.0" } };
  const library = modelLibrary(catalog, access, { engine: "claude", locked: false });
  const byKey = new Map(library.available.map((group) => [group.key, group]));
  assert.deepEqual(byKey.get("claude")!.hint, { kind: "sign-in" });
  assert.equal(byKey.get("claude")!.selectable, false);
  assert.deepEqual(byKey.get("codex")!.hint, { kind: "notice", notice: { blocking: true, message: "Codex is not installed.", fix: "brew install --cask codex" } });
  assert.equal(byKey.get("opencode:OpenRouter")!.hint?.kind, "notice", "a behind engine still runs, and says so");
  assert.equal(byKey.get("opencode:OpenRouter")!.selectable, true);
  assert.equal(byKey.get("opencode:Anthropic")!.hint, undefined);
});

test("the library holds only the models the installed command runs and the choice allows", () => {
  const access = { ...EVERY_ENGINE_READY, claude: { access: "ready" as const, models: ["opus", "sonnet"] } };
  const library = modelLibrary(catalog, access, { engine: "claude", locked: false, allows: (engine, model) => engine !== "claude" || model !== "sonnet" });
  assert.deepEqual(library.available[0]!.models.map((model) => model.id), ["opus"]);
});

const rows = (entries: ReturnType<typeof modelLibrary>["top"]) => entries.map(({ group, spec }) => `${group.key}/${spec.id}`);
const headed = (groups: ReturnType<typeof modelLibrary>["rest"]) => groups.map((group) => [group.key, group.models.map((model) => model.id)]);

test("the pins are kept in reach in the order they were made, after the model in use where it is not one, and every other model stays under its heading", () => {
  const favorites = [{ engine: "opencode" as const, model: "anthropic/opus" }, { engine: "claude" as const, model: "sonnet" }, { engine: "claude" as const, model: "gone" }];
  const pinned = modelLibrary(catalog, EVERY_ENGINE_READY, { engine: "claude", locked: false, model: "opus", favorites });
  assert.deepEqual(rows(pinned.top), ["claude/opus", "opencode:Anthropic/anthropic/opus", "claude/sonnet"], "Claude's Opus is not pinned by OpenCode's, and a pin nothing offers has no row");
  assert.deepEqual(pinned.top.map((entry) => entry.pinned), [false, true, true]);
  assert.equal(pinned.home, "claude");
  assert.deepEqual(headed(pinned.rest).slice(0, 1), [["claude", ["fable", "haiku"]]]);
  assert.ok(!pinned.rest.some((group) => group.key === "opencode:Anthropic"), "a heading whose models are all in reach is not listed again");

  const used = modelLibrary(catalog, EVERY_ENGINE_READY, { engine: "claude", locked: false, model: "sonnet", favorites });
  assert.deepEqual(rows(used.top), ["opencode:Anthropic/anthropic/opus", "claude/sonnet"], "a pinned model in use keeps its place among the pins");
});

test("with nothing pinned, the models under the heading in use are the ones in reach", () => {
  const settled = modelLibrary(catalog, EVERY_ENGINE_READY, { engine: "opencode", locked: true, model: "anthropic/opus" });
  assert.deepEqual([settled.home, rows(settled.top)], ["opencode:Anthropic", ["opencode:Anthropic/anthropic/opus"]]);
  assert.deepEqual(headed(settled.rest).at(-1), ["opencode:OpenRouter", ["openrouter/qwen-4", "openrouter/glm-5"]]);
  const gone = modelLibrary(catalog, EVERY_ENGINE_READY, { engine: "opencode", locked: true, model: "gone/model" });
  assert.equal(gone.home, "opencode:OpenRouter", "a model its provider no longer lists falls to the engine's first heading");
  assert.deepEqual(rows(modelLibrary(catalog, EVERY_ENGINE_READY, { engine: "claude", locked: false }).top), ["claude/fable", "claude/opus", "claude/sonnet", "claude/haiku"]);
});

test("a search reaches every model by its name or its provider's, in reach or not, and leaves out the headings it empties", () => {
  const favorites = [{ engine: "claude" as const, model: "opus" }];
  const found = modelLibrary(catalog, EVERY_ENGINE_READY, { engine: "claude", locked: false, model: "opus", favorites, query: " opus " });
  assert.deepEqual(rows(found.top), ["claude/opus"]);
  assert.deepEqual(headed(found.rest), [["opencode:Anthropic", ["anthropic/opus"]]]);
  const provider = modelLibrary(catalog, EVERY_ENGINE_READY, { engine: "claude", locked: false, model: "opus", favorites, query: "openrouter" });
  assert.deepEqual([rows(provider.top), headed(provider.rest)], [[], [["opencode:OpenRouter", ["openrouter/qwen-4", "openrouter/glm-5"]]]]);
});

test("what stands in the way of the thread's own engine is said beside the rows in reach, and not again under its heading", () => {
  const access = { ...EVERY_ENGINE_READY, codex: { access: "missing" as const }, opencode: { access: "ready" as const, version: "2.2.5", required: "2.3.0" } };
  const library = modelLibrary(catalog, access, { engine: "opencode", locked: false, model: "anthropic/opus" });
  assert.deepEqual([library.notice?.key, library.notice?.hint?.kind], ["opencode:OpenRouter", "notice"]);
  assert.deepEqual(library.rest.map((group) => [group.key, group.hint?.kind]), [["claude", undefined], ["codex", "notice"], ["opencode:OpenRouter", undefined]]);
});

test("an engine yet to name its models keeps one empty heading, so it can still say what stands in its way", () => {
  const library = modelLibrary(BUILT_IN_MODELS, { ...EVERY_ENGINE_READY, opencode: { access: "missing" } }, { engine: "claude", locked: false });
  const opencode = library.available.find((group) => group.engine === "opencode")!;
  assert.deepEqual([opencode.key, opencode.label, opencode.models.length, opencode.hint?.kind], ["opencode", "OpenCode", 0, "notice"]);
});

test("every picker offers an engine's modes in one order", () => {
  assert.deepEqual(offeredPolicies("claude"), ["autonomous", "bypass", "allow-edits", "confirm"]);
  assert.deepEqual(offeredPolicies("opencode"), ["bypass", "allow-edits", "confirm"]);
  assert.deepEqual(offeredPolicies("galaxy"), [], "an engine only a newer build knows offers none");
});

test("an engine's state reads as a word and a line", () => {
  assert.deepEqual([engineStatusWord({ access: "ready" }), engineStatusLine("claude", { access: "ready" })], ["Ready", "Installed and ready."]);
  assert.deepEqual([engineStatusWord({ access: "signed-out" }), engineStatusLine("codex", { access: "signed-out" })], ["Signed out", "Sign in to run threads on Codex."]);
  assert.deepEqual([engineStatusWord({ access: "missing" }), engineStatusLine("codex", { access: "missing" })], ["Not installed", "Codex is not installed."]);
  assert.deepEqual([engineStatusWord({ access: "ready", version: "2.1.0", latest: "2.2.0" }), engineStatusLine("claude", { access: "ready", version: "2.1.0", latest: "2.2.0" })], ["Update available", "Version 2.1.0. 2.2.0 is available; update it the way you installed it."]);
});
