import assert from "node:assert/strict";
import { test } from "vitest";
import type { AutomationBridge, BrowserBridge, FindingBridge, ProviderEvent, TerminalBridge, ThreadBridge } from "../../../src/main/agent/agent-provider.mts";
import { runTools } from "../../../src/main/agent/run-tools.mts";
import { codexConfig, toml } from "../../../src/main/codex/codex-config.mts";
import { DEVELOPER_INSTRUCTIONS } from "../../../src/main/codex/codex-session.mts";
import { harness, input, turn } from "../../support/codex-client.mjs";

const automations = { list: async () => [], read: async () => null, save: async () => ({}), update: async () => ({}), remove: async () => true } as unknown as AutomationBridge;
const findings = { notify: async () => ({}), nothingToReport: async () => ({}) } as unknown as FindingBridge;
const threads = { list: async () => [], read: async () => null, wait: async () => ({}), command: async () => ({}) } as unknown as ThreadBridge;
const browser: BrowserBridge = { command: async () => {}, read: async () => ({ kind: "tabs", tabs: [] }) };
const terminal = { read: async () => ({}) } as unknown as TerminalBridge;
const bridges = { automations, findings, threads, browser, terminal };

const cua = { command: "/app/cua-driver", args: ["mcp", "--embedded"], env: { CUA_DRIVER_EMBEDDED: "1" } };
const available = { status: "available" as const, mcp: cua };

/** The `-c key=value` overrides a spawn carried, by key. */
function overrides(args: readonly string[]) {
  const found: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "-c") continue;
    const [key, ...value] = args[index + 1]!.split("=");
    found[key!] = value.join("=");
  }
  return found;
}

test("a session serves the run's tools under one token and points the app server at them, pre-approved", async () => {
  const codex = harness();
  const { client } = await turn(codex, bridges);

  const toolOverrides = Object.fromEntries(Object.entries(overrides(client.command.args)).filter(([key]) => key.startsWith("mcp_servers.aicodingtool.")));
  assert.deepEqual(toolOverrides, {
    "mcp_servers.aicodingtool.url": "\"http://127.0.0.1:1/mcp\"",
    "mcp_servers.aicodingtool.bearer_token_env_var": "\"AICODINGTOOL_MCP_TOKEN\"",
    "mcp_servers.aicodingtool.default_tools_approval_mode": "\"approve\"",
  });
  assert.equal(client.command.env?.AICODINGTOOL_MCP_TOKEN, "token-1");
  assert.equal(client.command.env?.PATH, process.env.PATH, "the process keeps its environment");
  assert.equal(codex.host.served.length, 1);
  assert.deepEqual(
    codex.host.served[0]!.tools.map((tool) => tool.name).sort(),
    runTools(input(bridges)).flatMap((set) => set.tools.map((tool) => tool.name)).sort(),
  );
  assert.ok(codex.host.served[0]!.tools.some((tool) => tool.name === "schedule"));
  assert.equal((client.calls("thread/start")[0] as { developerInstructions?: string }).developerInstructions, DEVELOPER_INSTRUCTIONS);
  assert.ok(DEVELOPER_INSTRUCTIONS.split(/\s+/).length < 100, "the instructions stay short");

  await turn(codex, { ...bridges, prompt: "again", continuation: { provider: "codex", value: "thread-1" } });
  assert.equal(codex.host.served.length, 1, "a warm session keeps its token");
  assert.equal(codex.host.served[0]!.released, false);
  codex.provider.closeAll();
  assert.equal(codex.host.served[0]!.released, true, "closing the session forgets its token");
});

test("a native review cannot create regular app threads", () => {
  const tools = runTools(input({
    ...bridges,
    operation: { type: "review", target: { type: "uncommittedChanges" } },
  })).flatMap((set) => set.tools.map((tool) => tool.name));

  assert.ok(!tools.includes("list_threads"));
  assert.ok(!tools.includes("start_thread"));
  assert.ok(tools.includes("browser_open"), "unrelated review tools stay available");
});

test("a side chat is served the tools its channel allows, and a run with no bridges is served nothing", async () => {
  const side = harness();
  const { client } = await turn(side, { ...bridges, channel: "side" });
  const served = side.host.served[0]!.tools.map((tool) => tool.name);
  for (const withheld of ["schedule", "update", "stop", "notify", "nothing_to_report"]) assert.ok(!served.includes(withheld), withheld);
  assert.ok(served.includes("status") && served.includes("list_threads") && served.includes("browser_open"));
  assert.equal(overrides(client.command.args)["mcp_servers.aicodingtool.url"], "\"http://127.0.0.1:1/mcp\"");
  side.provider.closeAll();

  const bare = harness();
  const { client: plain } = await turn(bare);
  assert.deepEqual(overrides(plain.command.args)["mcp_servers.cua-driver.command"], undefined);
  assert.equal(bare.host.served.length, 0, "Codex reads its own skills without an app tool server");
  bare.provider.closeAll();
});

test("bundled computer use is configured as its own server and pre-approved only when the policy allows it", async () => {
  const prompting = harness();
  const { client: asked } = await turn(prompting, { computerUse: available, policy: "autonomous", channel: "side" });
  assert.deepEqual(Object.fromEntries(Object.entries(overrides(asked.command.args)).filter(([key]) => key.startsWith("mcp_servers.cua-driver."))), {
    "mcp_servers.cua-driver.command": "\"/app/cua-driver\"",
    "mcp_servers.cua-driver.args": "[\"mcp\", \"--embedded\"]",
    "mcp_servers.cua-driver.env": "{ \"CUA_DRIVER_EMBEDDED\" = \"1\" }",
  });
  prompting.provider.closeAll();

  const confirming = harness();
  const { client: confirmed } = await turn(confirming, { computerUse: available, policy: "confirm" });
  assert.equal(overrides(confirmed.command.args)["mcp_servers.cua-driver.default_tools_approval_mode"], undefined);

  const { client: granted } = await turn(confirming, { computerUse: available, policy: "autonomous", continuation: { provider: "codex", value: "thread-1" } });
  assert.notEqual(granted, confirmed, "the grant is the process's, so the policy switch opens a new one");
  assert.equal(overrides(granted.command.args)["mcp_servers.cua-driver.default_tools_approval_mode"], "\"approve\"");
  assert.equal(confirmed.closed, true);
  confirming.provider.closeAll();

  const bypassing = harness();
  const { client: bypassed } = await turn(bypassing, { computerUse: available, policy: "bypass", channel: "side" });
  assert.equal(overrides(bypassed.command.args)["mcp_servers.cua-driver.default_tools_approval_mode"], "\"approve\"");
  bypassing.provider.closeAll();

  const plain = harness();
  const { client: first } = await turn(plain, { policy: "confirm" });
  const { client: second } = await turn(plain, { policy: "autonomous", continuation: { provider: "codex", value: "thread-1" } });
  assert.equal(second, first, "with computer use off, a policy switch rides the warm session");
  plain.provider.closeAll();
});

test("while computer use still needs setup, the served setup tool asks the app to open it", async () => {
  const emitted: ProviderEvent[] = [];
  const codex = harness();
  await turn(codex, { computerUse: { status: "setup-required" }, emit: (event) => emitted.push(event) });
  const served = codex.host.served[0]!;
  assert.deepEqual(served.tools.map((tool) => tool.name), ["request_setup"]);
  const result = await served.call("request_setup", {});
  assert.deepEqual(emitted.filter((event) => event.type === "computer-use.setup-required"), [{ type: "computer-use.setup-required" }]);
  assert.match(result.content[0]!.text, /Settings → Computer use/);
  codex.provider.closeAll();
});

test("config values are written as TOML the app server parses", () => {
  assert.equal(toml("plain"), "\"plain\"");
  assert.equal(toml("a\"b\\c\nd\te"), "\"a\\\"b\\\\c\\nd\\te\\u0001\\u007f\"");
  assert.equal(toml(true), "true");
  assert.equal(toml(["x", "y z"]), "[\"x\", \"y z\"]");
  assert.equal(toml({}), "{}");
  assert.equal(toml({ "A-B": "1", C: "\"" }), "{ \"A-B\" = \"1\", \"C\" = \"\\\"\" }");
  assert.equal(toml([{ name: "a:b", enabled: false }]), "[{ \"name\" = \"a:b\", \"enabled\" = false }]");
  assert.deepEqual(
    codexConfig({ channel: "main", policy: "confirm", computerUse: { status: "unavailable", message: "off" } }, undefined),
    ["--disable", "plugins", "--enable", "goals"],
    "Codex's desktop-app plugins stay off while its native goal feature is enabled",
  );
});
