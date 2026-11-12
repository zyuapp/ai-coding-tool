import { fakeDesktop } from "../support/desktop-api.mts";
import { task } from "../application/workspace-reducer-fixtures.mts";
import type { LoadedTaskStore, RunCommand } from "../../src/contracts/ipc.ts";
import type { ConversationMessage } from "../../src/domain/conversation.ts";

/** The real window over the fake desktop, with seeded threads and an engine that streams, asks and fails. */

const now = Date.now();
const REPLIES = [
  "Here is the fix:\n\n```ts\nexport function add(a: number, b: number) {\n  return a + b;\n}\n```\n\nDone.",
  "| File | Change |\n|---|---|\n| `src/a.ts` | renamed |\n| `src/b.ts` | deleted |\n\nAll tests pass.",
  `A very long path: /Users/someone/${"x".repeat(400)}/file.ts`,
  "مرحبا بالعالم — שלום עולם — 你好世界 👩‍👩‍👧‍👦🏳️‍🌈 ‮reversed‬",
  "- one\n- two\n  - nested **bold** _it_ `code`\n- [link](https://example.com)\n\n> quote\n\n# Heading\n\n" + "para ".repeat(300),
];

let messageId = 0;
const message = (kind: ConversationMessage["kind"], text: string, at: number): ConversationMessage => ({ id: `seed-${messageId += 1}`, kind, text, at });

const project = { id: "project-1", root: "/repo", workspaceId: "workspace-1" };
const nested = { id: "project-2", root: "/Users/someone/very/deeply/nested/folder/with-a-really-long-project-name-that-keeps-going", workspaceId: "workspace-2" };
const tasks = [
  task("t-1", { title: "Fix the flaky login test", projectId: project.id, updatedAt: now - 1000, messages: [message("user", "Fix the login test", now - 5000), message("assistant", REPLIES[0]!, now - 4000)] }),
  task("t-2", { title: "مرحبا — RTL title 👩‍👩‍👧", projectId: project.id, updatedAt: now - 2000, messages: [message("user", REPLIES[3]!, now - 6000), message("assistant", REPLIES[1]!, now - 5500)] }),
  task("t-3", { title: "A".repeat(200), projectId: nested.id, updatedAt: now - 3000, messages: [message("user", "long", now - 7000), message("assistant", REPLIES[2]!, now - 6500), message("system", "Run failed: something broke", now - 6400)] }),
  task("t-4", { title: "Empty thread", projectId: nested.id, updatedAt: now - 4000 }),
  task("t-5", { title: "Codex thread", engine: "codex", projectId: project.id, updatedAt: now - 5000, messages: [message("user", "hi", now - 9000), message("assistant", REPLIES[4]!, now - 8000)] }),
];
const store = { version: 2, hiddenTasks: 0, projects: [project, nested], worktrees: [], tasks, lastFolder: project.root } as unknown as LoadedTaskStore;

type LiveRun = { taskId: string; sequence: number; timers: ReturnType<typeof setTimeout>[]; awaitingApproval: boolean };
const live = new Map<string, LiveRun>();

const desktop = fakeDesktop({
  loadTaskStore: async () => structuredClone(store),
  loadThreadMessages: async (id: string) => structuredClone(tasks.find((each) => each.id === id)?.messages ?? []),
});
const send = desktop.send;
const emit = (event: Record<string, unknown>) => desktop.listener(event as never);

function finish(runId: string, status: "succeeded" | "cancelled" | "failed") {
  const run = live.get(runId);
  if (!run) return;
  run.timers.forEach(clearTimeout);
  live.delete(runId);
  emit({ type: "run.status", taskId: run.taskId, runId, sequence: (run.sequence += 1), status, ...(status === "failed" ? { message: "Engine exited" } : {}) });
}

function streamReply(runId: string) {
  const run = live.get(runId);
  if (!run) return;
  const reply = REPLIES[Math.floor(Math.random() * REPLIES.length)]!;
  const messageId = `reply-${runId}`;
  /** As an engine streams: the unfinished block as a tail, then each finished block once as a delta. */
  const steps: Record<string, unknown>[] = [];
  for (const block of markdownBlocks(reply)) {
    const chunks = block.match(/[\s\S]{1,60}/g) ?? [block];
    chunks.slice(0, -1).forEach((_, index) => steps.push({ type: "assistant.tail", messageId, text: chunks.slice(0, index + 1).join("") }));
    steps.push({ type: "assistant.delta", messageId, text: block, append: true });
  }
  steps.forEach((step, index) => {
    run.timers.push(setTimeout(() => emit({ ...step, taskId: run.taskId, runId, sequence: (run.sequence += 1) }), 40 * (index + 1)));
  });
  const failed = Math.random() < 0.1;
  run.timers.push(setTimeout(() => finish(runId, failed ? "failed" : "succeeded"), 40 * (steps.length + 2)));
}

/** Blank-line-separated blocks, keeping a fenced code block whole; each keeps the break after it. */
function markdownBlocks(text: string): string[] {
  const blocks: string[] = [];
  let open = "";
  for (const piece of text.split(/(?<=\n\n)/)) {
    open += piece;
    if ((open.match(/```/g)?.length ?? 0) % 2 === 0) {
      blocks.push(open);
      open = "";
    }
  }
  if (open) blocks.push(open);
  return blocks;
}

function start(command: Extract<RunCommand, { type: "start" }>) {
  const run: LiveRun = { taskId: command.taskId, sequence: 0, timers: [], awaitingApproval: false };
  live.set(command.runId, run);
  run.timers.push(setTimeout(() => {
    emit({ type: "run.status", taskId: command.taskId, runId: command.runId, sequence: (run.sequence += 1), status: "running" });
    if (Math.random() >= 0.25) return streamReply(command.runId);
    const input = { command: "rm -rf node_modules && npm install" };
    run.awaitingApproval = true;
    emit({ type: "approval.requested", taskId: command.taskId, runId: command.runId, sequence: (run.sequence += 1), approvalId: `approval-${command.runId}`, title: "Run a command", description: input.command, intent: { toolId: `tool-${command.runId}`, name: "Bash", input } });
    emit({ type: "run.status", taskId: command.taskId, runId: command.runId, sequence: (run.sequence += 1), status: "awaiting-approval" });
  }, 30));
}

desktop.send = (command: RunCommand) => {
  send(command);
  if (command.type === "start") start(command);
  else if (command.type === "cancel") {
    for (const [runId, run] of live) if (run.taskId === command.taskId) finish(runId, "cancelled");
  } else if (command.type === "approval") {
    const run = live.get(command.runId);
    if (!run?.awaitingApproval) return;
    run.awaitingApproval = false;
    emit({ type: "run.status", taskId: run.taskId, runId: command.runId, sequence: (run.sequence += 1), status: "running" });
    streamReply(command.runId);
  }
};

Object.assign(window, { desktop, __fuzz: { desktop } });

await import("../../src/renderer/app-entry.tsx");
