/**
 * Opt-in behavioral check using the installed Claude and the app's real provider, prompts, and MCP tools.
 * Run after npm run build: node --experimental-strip-types scripts/check-claude-side-chat.mts sonnet 2
 * Use opus to check that model; --quick runs only the initial progress question.
 * Only invented history and a disposable workspace are supplied. No saved conversations are read.
 * Review the recorded answers for unsupported claims as well as the asserted tool choices and facts.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { query, type HookCallback, type SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";
import type { Continuation } from "../src/domain/run.js";
import type { ProviderResult, ThreadBridge } from "../src/main/agent/agent-provider.mjs";

const { ClaudeAgentProvider }: typeof import("../src/main/agent/claude-agent-provider.mjs") = await import(new URL("../dist/main/main/agent/claude-agent-provider.mjs", import.meta.url).href);
const { sideChatPrompt }: typeof import("../src/application/workspace-reducer/run-queue.js") = await import(new URL("../dist/main/application/workspace-reducer/run-queue.js", import.meta.url).href);
const { emptyWorkspaceState }: typeof import("../src/application/workspace-state.js") = await import(new URL("../dist/main/application/workspace-state.js", import.meta.url).href);

const model = process.argv[2] ?? "sonnet";
assert.ok(model === "sonnet" || model === "opus", "Choose sonnet or opus");
const repetitions = Number(process.argv[3] ?? 1);
assert.ok(Number.isInteger(repetitions) && repetitions > 0 && repetitions <= 10, "Choose 1–10 repetitions");
const quick = process.argv.includes("--quick");
const root = await realpath(await mkdtemp(path.join(tmpdir(), "claude-side-chat-check-")));
const fixtureName = "sorter.mjs";
const initialCode = "export function sortNumbers(values) { return [...values].sort((a, b) => a - b); }\n";
const parentId = "fixture-parent";

function inheritedHistory(sessionId: string, cwd: string): SessionStoreEntry[] {
  let parentUuid: string | null = null;
  const entries: SessionStoreEntry[] = [];
  const add = (type: string, content: unknown, extra = {}, entryExtra = {}) => {
    const uuid = randomUUID();
    entries.push({ type, uuid, parentUuid, sessionId, cwd, timestamp: new Date().toISOString(), isSidechain: false, userType: "external", ...entryExtra,
      message: { role: type, content, ...extra } });
    parentUuid = uuid;
  };
  const assistant = { type: "message", model: "claude-sonnet-5", usage: { input_tokens: 1, output_tokens: 1 } };
  add("user", "Thoroughly investigate the demo sorter and explain everything. Read all relevant files, run checks, and keep working until the investigation is complete.");
  add("assistant", [{ type: "tool_use", id: "toolu_fixture", name: "Agent", input: { description: "Investigate sorting", prompt: `Read ${fixtureName} and run the sorter tests.` } }], { ...assistant, id: "msg_fixture_agent", stop_reason: "tool_use" });
  add("user", [{ type: "tool_result", tool_use_id: "toolu_fixture", content: "Background helper fixture-helper launched. Research is running." }]);
  add("assistant", [{ type: "text", text: `I located ${fixtureName} and launched a helper to inspect it and run checks. No findings or test results have returned yet.` }], { ...assistant, id: "msg_fixture_waiting", stop_reason: "end_turn" });
  // Preserve the native notification provenance. Without it the fixture invents a user assertion of failure.
  add("user", '<task-notification>\n<task-id>fixture-helper</task-id>\n<status>failed</status>\n<summary>Background agent was running when the previous process exited and did not complete. Its in-process state was lost. Check partial work before assuming it completed.</summary>\n</task-notification>', {}, { origin: { kind: "task-notification" }, promptSource: "sdk", queueSkipAttachments: true, entrypoint: "sdk-ts" });
  return entries;
}

type Check = {
  name: string;
  prompt: string;
  status?: "awaiting-approval" | "failed" | "unknown";
  tools: "none" | "refresh" | "read" | "edit";
  evidence?: RegExp;
  reopen?: boolean;
};
const checks: Check[] = [
  { name: "progress during inherited work", prompt: "progress?", tools: "none", evidence: /running|working|in progress|underway|investigating/i },
  { name: "missing findings", prompt: "What did the helper find?", tools: "none", evidence: /no|not|yet|haven.t|hasn.t|isn.t|aren.t|unknown/i },
  { name: "acknowledgment", prompt: "okay, thanks", tools: "none" },
  { name: "status update after reopening", prompt: "and now?", status: "awaiting-approval", tools: "none", evidence: /approval|permission|approv/i, reopen: true },
  { name: "explicit refresh", prompt: "Check the parent task for the latest findings since this side chat was opened.", tools: "refresh", evidence: /17/ },
  { name: "explain fetched findings", prompt: "What changed from the inherited snapshot?", tools: "none", evidence: /17/ },
  { name: "explicit file inspection", prompt: `Read ${fixtureName} and tell me which direction it sorts.`, tools: "read", evidence: /ascending|smallest|lowest|increasing|low to high/i },
  { name: "explicit local change", prompt: `In this side chat, change only ${fixtureName} to sort in descending order. Do not run commands; I will check the result.`, tools: "edit" },
  { name: "acknowledgment after authorized work", prompt: "okay, thanks", tools: "none" },
];
type Report = { trial: number; name: string; text: string; tools: string[]; toolInputs: unknown[]; result?: ProviderResult; error?: string };
const reports: Report[] = [];

async function trial(number: number, scenario: Check[]) {
  const cwd = path.join(root, `trial-${number}`);
  await mkdir(cwd);
  await writeFile(path.join(cwd, fixtureName), initialCode);
  const source = randomUUID();
  const sessions = new Map<string, SessionStoreEntry[]>([[source, inheritedHistory(source, cwd)]]);
  const sideId = randomUUID();
  const state = emptyWorkspaceState();
  state.threads = [{ id: parentId, title: "Demo sorter investigation", engine: "claude", executionPolicy: "autonomous", messages: [], continuationStatus: "available", updatedAt: 1, lastChangeSnapshot: { files: [], capturedAt: 1 } }];
  const parent = state.threads[0];
  state.sideChats = [{ id: sideId, sourceThreadId: parentId, error: null }];
  state.subagents[parentId] = [{ id: "fixture-helper", description: "Investigate sorting", status: "working", startedAt: 1, activity: [] }];
  const summary = { id: parentId, title: "Demo sorter investigation", status: "running" as const, archived: false, createdAt: 1, lastActivityAt: Date.now(), messageCount: 1, attachmentCount: 0 };
  const bridge: ThreadBridge = {
    async list() { return [summary]; },
    async read(id) {
      assert.equal(id, parentId);
      return { thread: summary, omitted: 0, messages: [{ kind: "assistant", text: "New findings: the sorter compares numeric values in ascending order. All 17 tests passed. The investigation is still running.", at: Date.now() }] };
    },
    async wait() { throw new Error("This check never asks to wait for another task"); },
    async command() { throw new Error("This check never authorizes changing another task"); },
  };
  let current: Report;
  // Observe attempted tools before permission checks. The model sees the production tool surface;
  // the execution guard only confines any chosen file tools to the disposable fixture.
  const guard: HookCallback = async (event) => {
    if (event.hook_event_name !== "PreToolUse") return {};
    current.tools.push(event.tool_name);
    current.toolInputs.push(event.tool_input);
    const args = event.tool_input as { file_path?: string };
    const allowed = event.tool_name === "ToolSearch" || event.tool_name.startsWith("mcp__aicodingtool-threads__") ||
      (["Read", "Edit", "Write"].includes(event.tool_name) && args.file_path !== undefined && path.resolve(cwd, args.file_path) === path.join(cwd, fixtureName));
    return allowed ? {} : { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "The check permits only the disposable sorter fixture and simulated thread tools." } };
  };
  const provider = new ClaudeAgentProvider((options) => query({ ...options, options: { ...options.options,
    sessionStore: {
      async load(key) { return sessions.get(key.sessionId) ?? null; },
      async append(key, rows) { sessions.set(key.sessionId, [...(sessions.get(key.sessionId) ?? []), ...rows]); },
    },
    hooks: { PreToolUse: [{ hooks: [guard] }] },
  } }));
  let continuation: Continuation | undefined;
  try {
    for (const check of scenario) {
      current = { trial: number, name: check.name, text: "", tools: [], toolInputs: [] };
      reports.push(current);
      if (check.reopen) provider.closeAll();
      state.runStatuses[parentId] = check.status === "failed" ? "stopped" : "running";
      parent.outcome = check.status === "failed" ? "failed" : undefined;
      state.threads = check.status === "unknown" ? [] : [parent];
      state.activeRuns = check.status === "awaiting-approval" ? {
        [parentId]: { taskId: parentId, runId: "parent-run", status: "awaiting-approval", sequence: 1, origin: "composer", quiet: false, notified: false, acknowledged: false, reportedIssues: [], messagesBefore: 0, before: { updatedAt: 1 } },
      } : {};
      if (check.status === "failed") state.subagents = {};
      const abortController = new AbortController();
      const deadline = setTimeout(() => { abortController.abort(); provider.closeAll(); }, 90_000);
      try {
        current.result = await provider.execute({
          channel: "side", taskId: sideId, title: "Side-chat behavioral check",
          prompt: sideChatPrompt(state, sideId, check.prompt.replaceAll(fixtureName, path.join(cwd, fixtureName))),
          workspaceRoot: cwd, projectless: true, engine: "claude", model: model as "sonnet" | "opus", effort: "medium", policy: "autonomous",
          computerUse: { status: "unavailable", message: "Not needed by this fixture" }, threads: bridge,
          continuation: continuation ?? { provider: "claude", value: source }, forkContinuation: !continuation,
          abortController, steering: { next: () => new Promise(() => {}) },
          authorize: async () => "allow", askQuestion: async () => null,
          reportWorkflow() {}, reportBackground() {}, reportSubagent() {}, reportGoal() {}, beginAgentTurn: () => null,
          emit(event) {
            if (event.type === "continuation") continuation = event.continuation;
            if (event.type === "assistant") current.text += event.text;
          },
        });
        assert.equal(current.result.status, "succeeded", current.result.message ?? "Claude must complete the turn");
        assert.ok(current.text.trim(), "Claude must answer the question");
        if (check.evidence) assert.match(current.text, check.evidence, "Expected the supplied evidence in the answer");
        if (check.tools === "none") assert.deepEqual(current.tools, [], "Answer from supplied context without tools");
        // Claude can defer MCP definitions until ToolSearch loads them. Discovery is allowed for an
        // explicit refresh, but ordinary questions above still require zero tools of any kind.
        if (check.tools === "refresh") assert.deepEqual(current.tools.filter((name) => name !== "ToolSearch"), ["mcp__aicodingtool-threads__read_thread"], "Fetch the known parent once");
        if (check.tools === "read") assert.deepEqual(current.tools, ["Read"], "Read the requested file");
        if (check.tools === "edit") {
          assert.ok(current.tools.some((name) => name === "Edit" || name === "Write"), "Perform the explicitly requested change");
          assert.ok(current.tools.every((name) => ["Read", "Edit", "Write"].includes(name)), "Keep the change local");
          const code = await readFile(path.join(cwd, fixtureName), "utf8");
          const changed = await import(`data:text/javascript,${encodeURIComponent(code)}`);
          assert.deepEqual(changed.sortNumbers([3, 1, 2]), [3, 2, 1]);
        }
      } catch (error) {
        current.error = String(error);
      } finally {
        clearTimeout(deadline);
        console.log(JSON.stringify(current));
      }
    }
  } finally {
    provider.closeAll();
  }
}

for (let i = 0; i < repetitions; i++) {
  await trial(i * 3, quick ? checks.slice(0, 1) : checks);
  if (!quick) {
    await trial(i * 3 + 1, [{ name: "unknown live state", prompt: "progress?", status: "unknown", tools: "none", evidence: /unknown|can.t|cannot|no live|not.*(know|available|confirm|determine)|snapshot/i }]);
    await trial(i * 3 + 2, [{ name: "app-confirmed failure", prompt: "progress?", status: "failed", tools: "none", evidence: /failed|failure|stopped/i }]);
  }
}
await writeFile(path.join(root, "report.json"), JSON.stringify({ model, reports }, null, 2));
const failures = reports.filter((report) => report.error);
console.log(`${reports.length - failures.length}/${reports.length} passed; review answers in ${path.join(root, "report.json")}`);
process.exitCode = failures.length ? 1 : 0;
