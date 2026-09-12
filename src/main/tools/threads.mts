import { z } from "zod";
import { MAX_THREAD_WAIT_MS } from "../../contracts/ipc.js";
import type { ThreadSummary, ThreadTranscript } from "../../contracts/threads.js";
import { AGENT_ENGINES, isAgentEffort, isAgentModel, modelsFor, type AgentModel } from "../../domain/agent-engine.js";
import type { AgentEffort } from "../../domain/run.js";
import { THREAD_ROLES, type ThreadRole } from "../../domain/thread-role.js";
import type { ThreadBridge } from "../agent/agent-provider.mjs";
import { bindTools, defineTool, type ToolDefinition } from "./tool-definition.mjs";

export const THREAD_SERVER_NAME = "aicodingtool-threads";

/** The workspace bridge with the clock idle times are measured against. */
export type ThreadToolContext = { bridge: ThreadBridge; now: () => number };

const MINUTE = 60_000;
const DEFAULT_WAIT_MS = 5 * MINUTE;

const threadIdField = z.string().describe("The thread's known ID, an unambiguous prefix of it, or its exact title. Use list_threads only if you need to discover the target.");

const projectField = z.string().optional().describe(
  "\"current\" (the default) for the project this thread belongs to, \"all\" for every project, or a project named by its folder name or its path.",
);

const modelIds = AGENT_ENGINES.flatMap((engine) => modelsFor(engine).map((model) => model.id));
const effortIds = [...new Set(AGENT_ENGINES.flatMap((engine) => modelsFor(engine).flatMap((model) => model.efforts.map((effort) => effort.id))))];
const modelField = z.enum(modelIds as [AgentModel, ...AgentModel[]]).refine(isAgentModel).optional().describe(
  "Model for the new thread. Omit to inherit the calling thread's model.",
);
const roleIds = THREAD_ROLES.map((option) => option.role);
const roleField = z.enum(roleIds as [ThreadRole, ...ThreadRole[]]).optional().describe(
  "The part the new thread plays beside the others: coordinator, implementer, reviewer, or researcher. Shown on its row.",
);
const effortField = z.enum(effortIds as [AgentEffort, ...AgentEffort[]]).refine(isAgentEffort).optional().describe(
  "Effort for the new thread. Omit to inherit the calling thread's effort when the selected model supports it, otherwise use that engine's default.",
);

function elapsed(ms: number) {
  const minutes = Math.floor(ms / MINUTE);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ""}` : `${Math.floor(hours / 24)}d`;
}

function describe(thread: ThreadSummary, at: number) {
  const parts = [
    `${thread.title} [${thread.id}]`,
    ...(thread.role ? [`role ${thread.role}`] : []),
    thread.worktreeRoot ?? thread.projectRoot ?? "no project",
    ...(thread.worktreeId ? [`worktree ${thread.worktreeId}`] : []),
    thread.status,
    `${thread.messageCount} messages`,
    ...(thread.attachmentCount ? [`${thread.attachmentCount} with images`] : []),
    `idle ${elapsed(Math.max(0, at - thread.lastActivityAt))}`,
    ...(thread.archived ? ["archived"] : []),
  ];
  return parts.join(" · ");
}

function transcriptText(transcript: ThreadTranscript, at: number) {
  const lines = [
    describe(transcript.thread, at),
    ...(transcript.omitted ? [`(${transcript.omitted} earlier messages not shown)`] : []),
    "",
    ...transcript.messages.map((message) => `[${message.kind}] ${message.text}`),
  ];
  return lines.join("\n");
}

async function report(work: () => Promise<string>) {
  try {
    return { content: [{ type: "text" as const, text: await work() }] };
  } catch (error) {
    return { content: [{ type: "text" as const, text: `Thread error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export const THREAD_TOOLS: readonly ToolDefinition<ThreadToolContext>[] = [
  defineTool({
    name: "list_threads",
    description: "List the other AICodingTool threads, newest activity first. Use when the user asks what else is going on, points at recent or related work, or describes threads by age rather than by name.",
    input: {
      project: projectField,
      archived: z.boolean().optional().describe("List archived threads instead of active ones."),
      idleMinutes: z.number().optional().describe("Only threads that have done nothing for at least this many minutes."),
      search: z.string().optional().describe("Only threads whose title or messages contain this text."),
      hasImages: z.boolean().optional().describe("Only threads where a message carries an image."),
      limit: z.number().optional().describe("How many threads to return. Defaults to 20."),
    },
    readOnly: true,
    run: ({ bridge, now }, args) => report(async () => {
      const at = now();
      const threads = await bridge.list({
        ...(args.project === undefined ? {} : { project: args.project }),
        ...(args.archived === undefined ? {} : { archived: args.archived }),
        ...(args.idleMinutes === undefined ? {} : { idleForMs: args.idleMinutes * MINUTE }),
        ...(args.search === undefined ? {} : { search: args.search }),
        ...(args.hasImages === undefined ? {} : { attachments: args.hasImages }),
        limit: args.limit ?? 20,
      });
      return threads.length ? threads.map((thread) => describe(thread, at)).join("\n") : "No thread matches.";
    }),
  }),
  defineTool({
    name: "read_thread",
    description: "Read another thread's transcript when the request calls for fetching its contents. Use a known ID directly, including one supplied in app context or an aicodingtool://thread/<id> link. Use list_threads first only when the target is unknown.",
    input: {
      threadId: threadIdField,
      limit: z.number().optional().describe("How many of the newest messages to read. Defaults to 30."),
    },
    readOnly: true,
    run: ({ bridge, now }, args) => report(async () => transcriptText(await bridge.read(args.threadId, args.limit), now())),
  }),
  defineTool({
    name: "wait_for_thread",
    description: "Wait until a thread stops working and report what it last said. Use after start_thread or message_thread when the user is waiting on that work; polling read_thread instead just burns turns. A wait that runs out says so, and calling it again keeps waiting.",
    input: {
      threadId: threadIdField,
      timeoutSeconds: z.number().optional().describe("How long to wait before reporting back regardless. Defaults to 300, and cannot exceed 900."),
    },
    readOnly: true,
    run: ({ bridge, now }, args) => report(async () => {
      const timeoutMs = Math.min(args.timeoutSeconds === undefined ? DEFAULT_WAIT_MS : Math.max(0, args.timeoutSeconds) * 1_000, MAX_THREAD_WAIT_MS);
      const { thread, timedOut, reply } = await bridge.wait(args.threadId, timeoutMs);
      const heading = timedOut ? `Still working after ${Math.round(timeoutMs / 1_000)}s` : "Finished";
      return [`${heading}: ${describe(thread, now())}`, ...(reply ? ["", reply] : [])].join("\n");
    }),
  }),
  defineTool({
    name: "start_thread",
    description: "Start a new AICodingTool thread on its own prompt and run it. Use when the user asks for separate pieces of work to run side by side, one thread per piece. The new thread runs with the permission policy the app is set to, so write a prompt that stands on its own. It starts in this thread's checkout, worktree included. Pass worktree to give it an isolated checkout instead, which is what you want when it edits the same files as this thread.",
    input: {
      prompt: z.string().describe("The first message of the new thread. It has none of this conversation's context, so say everything it needs."),
      project: z.string().optional().describe("Which project to start it in: its folder name, its path, or its id. Defaults to this thread's project."),
      worktree: z.boolean().optional().describe("Run the new thread in its own new git worktree, detached at whatever the project has checked out, so its edits never touch this thread's checkout."),
      worktreeId: z.string().optional().describe("Start the thread in another worktree that already exists, as list_threads reports it. Omit both worktree fields to share this thread's checkout. Takes precedence over worktree."),
      model: modelField,
      effort: effortField,
      role: roleField,
    },
    readOnly: false,
    run: ({ bridge, now }, args) => report(async () => {
      const { thread } = await bridge.command({
        type: "task.send",
        text: args.prompt,
        ...(args.project ? { project: args.project } : {}),
        ...(args.worktreeId ? { worktreeId: args.worktreeId } : args.worktree ? { worktree: true } : {}),
        ...(args.model ? { model: args.model } : {}),
        ...(args.effort ? { effort: args.effort } : {}),
        ...(args.role ? { role: args.role } : {}),
      });
      return thread ? `Started ${describe(thread, now())}` : "The thread did not start.";
    }),
  }),
  defineTool({
    name: "message_thread",
    description: "Send a message to another thread. It waits for that thread's current run to finish unless steer is true, which pushes it into the run already going.",
    input: {
      threadId: threadIdField,
      text: z.string().describe("The message to send."),
      steer: z.boolean().optional().describe("Interrupt the run already going instead of queueing behind it."),
    },
    readOnly: false,
    run: ({ bridge, now }, args) => report(async () => {
      const { thread } = await bridge.command({ type: "task.send", taskId: args.threadId, text: args.text, ...(args.steer ? { steer: true } : {}) });
      return thread ? `Sent to ${describe(thread, now())}` : "The message was not delivered.";
    }),
  }),
  defineTool({
    name: "set_thread_role",
    description: "Give a thread its part beside the others, or take it off. The role shows on the thread's row and in list_threads; it changes nothing about what the thread may do.",
    input: {
      threadId: threadIdField,
      role: z.enum(roleIds as [ThreadRole, ...ThreadRole[]]).nullable().describe("coordinator, implementer, reviewer, or researcher. null takes the role off."),
    },
    readOnly: false,
    run: ({ bridge, now }, args) => report(async () => {
      const { thread } = await bridge.command({ type: "task.set-role", taskId: args.threadId, role: args.role });
      return thread ? `${args.role ? "Set the role of" : "Took the role off"} ${describe(thread, now())}` : "The thread's role was not changed.";
    }),
  }),
  defineTool({
    name: "archive_thread",
    description: "Archive a thread, which also cancels a run it still has going and retires its automation. Archived threads stay recoverable for five days. This throws away work in progress, so only archive when the user asked for it.",
    input: { threadId: threadIdField },
    readOnly: false,
    run: ({ bridge, now }, args) => report(async () => {
      const { thread } = await bridge.command({ type: "task.archive", taskId: args.threadId });
      return thread ? `Archived ${describe(thread, now())}` : "The thread was not archived.";
    }),
  }),
  defineTool({
    name: "stop_thread",
    description: "Stop the run a thread has going, leaving the thread itself alone. This throws away work in progress, so only stop a run when the user asked for it.",
    input: { threadId: threadIdField },
    readOnly: false,
    run: ({ bridge, now }, args) => report(async () => {
      const { thread } = await bridge.command({ type: "run.cancel", taskId: args.threadId });
      return thread ? `Asked this thread to stop: ${describe(thread, now())}` : "The thread was not stopped.";
    }),
  }),
];

export function threadTools(bridge: ThreadBridge, now: () => number = Date.now) {
  return bindTools({ bridge, now }, THREAD_TOOLS);
}
