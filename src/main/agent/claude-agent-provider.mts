import { createSdkMcpServer, query, tool, type CanUseTool, type McpServerConfig, type Query, type SDKUserMessage, type SlashCommand } from "@anthropic-ai/claude-agent-sdk";
import { existsSync } from "node:fs";
import path from "node:path";
import { emptyScan, scanBlocks, type BlockScan } from "../../domain/markdown-stream.js";
import { contextWindowLimit } from "../../domain/run.js";
import type { BackgroundProcess, BackgroundProcessKind, Continuation, ExecutionPolicy, ToolIntent } from "../../domain/run.js";
import type { AgentProvider, ProviderEvent, ProviderResult, ProviderRunInput, SteerQueue } from "./agent-provider.mjs";
import { automationServer, AUTOMATION_SERVER_NAME } from "./automation-tools.mjs";
import { browserServer, BROWSER_SERVER_NAME } from "./browser-tools.mjs";
import { terminalServer, TERMINAL_SERVER_NAME } from "./terminal-tools.mjs";
import { withheldTools } from "./channel-tools.mjs";
import { threadServer, THREAD_SERVER_NAME } from "./thread-tools.mjs";

type QueryFactory = typeof query;
const setupToolName = "mcp__claudex-computer-use__request_setup";
/** Scheduled runs have nobody to approve anything, and these tools only reach the run's own automation. */
const automationToolPrefix = `mcp__${AUTOMATION_SERVER_NAME}__`;
/** Reading the workspace changes nothing, so it needs no approval; starting or stopping a run does. */
const threadToolPrefix = `mcp__${THREAD_SERVER_NAME}__`;
const readOnlyThreadTools = new Set([`${threadToolPrefix}list_threads`, `${threadToolPrefix}read_thread`, `${threadToolPrefix}wait_for_thread`]);
/** Reading a page the panel already holds changes nothing; opening one and acting in it does. */
const browserToolPrefix = `mcp__${BROWSER_SERVER_NAME}__`;
const readOnlyBrowserTools = new Set([`${browserToolPrefix}browser_read`, `${browserToolPrefix}browser_tabs`]);
const browserInstructions = `The Claudex browser panel is a real browser sharing one session with the user, so every site they have signed into is signed in for you: use the claudex-browser tools rather than curl or Bash for anything behind a login, and rather than guessing at a page you can read. Open a page, read it, then act on the refs that read hands you — a ref is stale as soon as the page changes. The user sees the same tabs you drive, so leave their pages alone and close only the tabs you opened. An origin the user has never visited waits on their approval before it loads; say what you need it for instead of retrying.`;
const threadInstructions = `Claudex holds the user's other threads, and the claudex-threads tools are the only way to reach them. Read them with list_threads and read_thread when the user points at other, recent, or related work instead of guessing from memory. Start a thread per piece of work when the user asks for several things to run side by side, and give each one a prompt that stands alone: a new thread inherits none of this conversation. Wait on a thread you started with wait_for_thread rather than polling read_thread. Archiving or stopping a thread throws away work in progress, so only do it when the user asked for it. When you name another thread in an answer, link it as [title](claudex://thread/<id>) so the user can open it from your message.`;
const automationInstructions = `This task can schedule itself. When the user asks to repeat, babysit, poll, or watch something on a cadence, use the claudex-automation tools instead of looping yourself or reaching for cron. An automation runs the same prompt on its own schedule with no user present, so write the prompt to stand alone and carry its own stop condition. When a scheduled run is what is executing and that stop condition is met, call the stop tool; nothing else ends an automation.`;
const computerUseInstructions = `When a requested outcome lives in another application's interface, use the provided computer-use MCP tools. Never invoke a separately installed cua-driver through Bash. Observe the exact target before every action and verify the result afterward. Prefer accessibility targets, then screenshot coordinates, and use foreground delivery only after background delivery fails. If only request_setup is available, call it instead of telling the user to install or configure anything.`;

/** The task types that are processes of their own. Subagents and workflows have a panel already. */
const backgroundProcessKinds: Record<string, BackgroundProcessKind> = {
  local_bash: "shell",
  monitor_mcp: "monitor",
  monitor_ws: "monitor",
};

function backgroundProcesses(tasks: { task_id: string; task_type: string; description: string }[]): BackgroundProcess[] {
  return tasks.flatMap((task) => {
    const kind = backgroundProcessKinds[task.task_type];
    return kind ? [{ id: task.task_id, kind, description: task.description }] : [];
  });
}

async function* idlePrompt() {
  await new Promise<void>(() => {});
}

function userMessage(prompt: string): SDKUserMessage {
  return { type: "user", message: { role: "user", content: prompt }, parent_tool_use_id: null, session_id: "" };
}

/**
 * The run's input stays open for as long as the turn does, so a steered message can join the turn
 * instead of waiting for the next one. Each yield only returns once the SDK has taken the message,
 * which is when it counts as delivered.
 */
async function* runInput(prompt: string, steering: SteerQueue, onDelivered: (messageId: string) => void) {
  yield userMessage(prompt);
  for (let steer = await steering.next(); steer; steer = await steering.next()) {
    yield userMessage(steer.prompt);
    onDelivered(steer.messageId);
  }
}

export async function discoverClaudeCommands(workspaceRoot: string, projectless: boolean, queryFactory: QueryFactory = query): Promise<SlashCommand[]> {
  const session = queryFactory({
    prompt: idlePrompt(),
    options: {
      cwd: workspaceRoot,
      pathToClaudeCodeExecutable: packagedClaudeExecutable(),
      settingSources: projectless ? ["user"] : ["user", "project", "local"],
      skills: "all",
    },
  });
  try {
    return await session.supportedCommands();
  } finally {
    session.close();
  }
}

export function packagedClaudeExecutable(resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath) {
  if (!resourcesPath) return undefined;
  const executable = path.join(resourcesPath, "app.asar.unpacked", "node_modules", "@anthropic-ai", "claude-agent-sdk-darwin-arm64", "claude");
  return existsSync(executable) ? executable : undefined;
}

function claudePermissionMode(policy: ExecutionPolicy) {
  return {
    confirm: "default",
    plan: "plan",
    "allow-edits": "acceptEdits",
    autonomous: "auto",
  }[policy] as "default" | "plan" | "acceptEdits" | "auto";
}

function writePathFor(toolName: string, input: unknown) {
  if (!(toolName === "Write" || toolName === "Edit" || toolName === "NotebookEdit")) return undefined;
  if (!input || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  const value = record.file_path ?? record.notebook_path;
  return typeof value === "string" ? value : undefined;
}

/** Every skill runs through one tool, so the name carries the skill that was asked for. */
function toolDisplayName(toolName: string, input: unknown) {
  if (toolName !== "Skill" || !input || typeof input !== "object") return toolName;
  const skill = (input as Record<string, unknown>).skill;
  return typeof skill === "string" && skill ? `Skill: ${skill}` : toolName;
}

function normalizeToolIntent(toolName: string, input: unknown, toolUseID: string): ToolIntent {
  const writePath = writePathFor(toolName, input);
  return { toolId: toolUseID, name: toolDisplayName(toolName, input), input, ...(writePath === undefined ? {} : { writePath }) };
}

type MarkdownBuffer = {
  /** Text the stream has produced but not released yet. */
  text: string;
  scan: BlockScan;
};

/** Releases whole Markdown blocks and keeps the rest buffered, so a half-written fence never ships. */
function appendCompleteMarkdown(buffer: MarkdownBuffer, text: string) {
  buffer.text += text;
  const scan = scanBlocks(buffer.text, buffer.scan);
  buffer.scan = scan;
  if (!scan.safeEnd) return "";
  const complete = buffer.text.slice(0, scan.safeEnd);
  buffer.text = buffer.text.slice(scan.safeEnd);
  buffer.scan = { safeEnd: 0, scanned: scan.scanned - scan.safeEnd, ...(scan.fence ? { fence: scan.fence } : {}) };
  return complete;
}

export class ClaudeAgentProvider implements AgentProvider {
  constructor(private readonly queryFactory: QueryFactory = query) {}

  async execute(input: ProviderRunInput): Promise<ProviderResult> {
    let activeQuery: Query | null = null;
    const streamedText = new Map<string, MarkdownBuffer>();
    let activeMainStreamId: string | undefined;
    const subagentIds = new Set<string>();
    const subagentByToolUse = new Map<string, string>();
    const canUseTool: CanUseTool = async (toolName, toolInput, options) => {
      if (toolName === setupToolName || toolName.startsWith(automationToolPrefix) || readOnlyThreadTools.has(toolName) || readOnlyBrowserTools.has(toolName)) return { behavior: "allow", updatedInput: toolInput, toolUseID: options.toolUseID };
      if (input.channel === "main" && input.policy === "autonomous" && toolName.startsWith("mcp__cua-driver__")) return { behavior: "allow", updatedInput: toolInput, toolUseID: options.toolUseID };
      const intent = normalizeToolIntent(toolName, toolInput, options.toolUseID);
      const decision = await input.authorize(intent);
      return decision === "allow"
        ? { behavior: "allow", updatedInput: toolInput, toolUseID: options.toolUseID }
        : { behavior: "deny", message: "The user denied this action.", toolUseID: options.toolUseID };
    };

    try {
      const continuation = input.continuation?.provider === "claude" ? input.continuation.value : undefined;
      const mcpServers: Record<string, McpServerConfig> = {};
      if (input.computerUse.status === "available") {
        mcpServers["cua-driver"] = { type: "stdio" as const, ...input.computerUse.mcp };
      } else if (input.computerUse.status === "setup-required") {
        mcpServers["claudex-computer-use"] = createSdkMcpServer({
          name: "claudex-computer-use",
          version: "1.0.0",
          alwaysLoad: true,
          tools: [tool("request_setup", "Use when a task requires operating another application's interface but computer use needs to be enabled in Claudex.", {}, async () => {
            input.emit({ type: "computer-use.setup-required" });
            return { content: [{ type: "text", text: "Claudex opened Settings → Computer use. Ask the user to complete the required permissions, then retry after Claudex restarts." }] };
          })],
        });
      }
      if (input.automations) mcpServers[AUTOMATION_SERVER_NAME] = automationServer(input.automations);
      if (input.threads) mcpServers[THREAD_SERVER_NAME] = threadServer(input.threads);
      if (input.browser) mcpServers[BROWSER_SERVER_NAME] = browserServer(input.browser);
      if (input.terminal) mcpServers[TERMINAL_SERVER_NAME] = terminalServer(input.terminal);
      activeQuery = this.queryFactory({
        prompt: runInput(input.prompt, input.steering, (messageId) => input.emit({ type: "steered", messageId })),
        options: {
          cwd: input.workspaceRoot,
          pathToClaudeCodeExecutable: packagedClaudeExecutable(),
          disallowedTools: withheldTools(input.channel),
          resume: continuation,
          ...(input.forkContinuation && continuation ? { forkSession: true } : {}),
          permissionMode: claudePermissionMode(input.policy),
          model: input.model,
          effort: input.effort,
          betas: ["context-1m-2025-08-07" as const],
          ...(Object.keys(mcpServers).length ? { mcpServers } : {}),
          systemPrompt: { type: "preset", preset: "claude_code", append: [computerUseInstructions, ...(input.automations ? [automationInstructions] : []), ...(input.threads ? [threadInstructions] : []), ...(input.browser ? [browserInstructions] : [])].join("\n\n") },
          settingSources: input.projectless ? ["user"] : ["user", "project", "local"],
          skills: "all",
          forwardSubagentText: true,
          includePartialMessages: true,
          canUseTool,
          abortController: input.abortController,
        },
      });
      const session = activeQuery;
      input.attach({ stopProcess: (processId) => session.stopTask(processId) });

      for await (const message of activeQuery) {
        if (message.type === "system" && message.subtype === "init") {
          input.emit({
            type: "continuation",
            continuation: { provider: "claude", value: message.session_id },
          });
        } else if (message.type === "system" && message.subtype === "compact_boundary") {
          input.emit({
            type: "compaction",
            trigger: message.compact_metadata.trigger,
            preTokens: message.compact_metadata.pre_tokens,
            ...(message.compact_metadata.post_tokens === undefined ? {} : { postTokens: message.compact_metadata.post_tokens }),
          });
        } else if (message.type === "system" && message.subtype === "status" && (message.status === "compacting" || message.compact_result)) {
          input.emit({
            type: "compaction-status",
            compacting: message.status === "compacting",
            ...(message.compact_result === "failed" ? { error: message.compact_error ?? "Context compaction failed." } : {}),
          });
        } else if (message.type === "system" && message.subtype === "background_tasks_changed") {
          input.emit({ type: "background.changed", processes: backgroundProcesses(message.tasks) });
        } else if (message.type === "system" && message.subtype === "task_started" && message.subagent_type) {
          subagentIds.add(message.task_id);
          if (message.tool_use_id) subagentByToolUse.set(message.tool_use_id, message.task_id);
          input.emit({
            type: "subagent.started",
            id: message.task_id,
            description: message.description,
            agentType: message.subagent_type,
          });
        } else if (message.type === "system" && message.subtype === "task_progress" && (message.subagent_type || subagentIds.has(message.task_id))) {
          input.emit({
            type: "subagent.progress",
            id: message.task_id,
            description: message.description,
            ...(message.last_tool_name ? { lastToolName: message.last_tool_name } : {}),
            ...(message.summary ? { summary: message.summary } : {}),
            totalTokens: message.usage.total_tokens,
          });
        } else if (message.type === "system" && message.subtype === "task_notification" && subagentIds.has(message.task_id)) {
          input.emit({
            type: "subagent.finished",
            id: message.task_id,
            status: message.status === "completed" ? "completed" : message.status,
            summary: message.summary,
          });
        } else if (message.type === "stream_event" && !message.parent_tool_use_id && message.event.type === "message_start") {
          activeMainStreamId = message.event.message.id;
          streamedText.set(activeMainStreamId, { text: "", scan: emptyScan() });
        } else if (message.type === "stream_event" && !message.parent_tool_use_id && activeMainStreamId && message.event.type === "content_block_delta" && message.event.delta.type === "text_delta") {
          const buffered = streamedText.get(activeMainStreamId);
          if (buffered) {
            const complete = appendCompleteMarkdown(buffered, message.event.delta.text);
            if (complete) input.emit({ type: "assistant", messageId: activeMainStreamId, text: complete, append: true });
            input.emit({ type: "assistant-tail", messageId: activeMainStreamId, text: buffered.text });
          }
        } else if (message.type === "assistant") {
          const subagentId = message.parent_tool_use_id ? subagentByToolUse.get(message.parent_tool_use_id) : undefined;
          if (subagentId) {
            for (const block of message.message.content) {
              if (block.type === "text" && block.text.trim()) {
                input.emit({ type: "subagent.activity", id: subagentId, activityId: `${message.uuid}:text`, kind: "text", text: block.text });
              } else if (block.type === "tool_use") {
                input.emit({ type: "subagent.activity", id: subagentId, activityId: block.id, kind: "tool", title: toolDisplayName(block.name, block.input), text: JSON.stringify(block.input, null, 2) });
              }
            }
            continue;
          }
          const streamId = message.message.id;
          const streamed = streamedText.get(streamId);
          if (streamed !== undefined) {
            if (streamed.text) input.emit({ type: "assistant", messageId: streamId, text: streamed.text, append: true });
            streamedText.delete(streamId);
            if (activeMainStreamId === streamId) activeMainStreamId = undefined;
          }
          for (const block of message.message.content) {
            if (block.type === "text" && streamed === undefined && block.text.trim()) {
              input.emit({ type: "assistant", messageId: message.uuid, text: block.text });
            } else if (block.type === "tool_use") {
              input.emit({
                type: "tool",
                intent: normalizeToolIntent(block.name, block.input, block.id),
              });
            }
          }
          const usage = message.message.usage;
          input.emit({
            type: "usage",
            tokens: usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0),
            limit: contextWindowLimit(input.model),
            model: message.message.model,
          });
        } else if (message.type === "result") {
          /** The open input stream keeps the session alive, so the turn's result is what ends the run. */
          if (message.subtype !== "success" || message.is_error) {
            return { status: "failed", message: message.subtype === "success" ? message.result : message.errors.join("\n") };
          }
          break;
        }
      }
      return { status: input.abortController.signal.aborted ? "cancelled" : "succeeded" };
    } catch (error) {
      if (input.abortController.signal.aborted) return { status: "cancelled" };
      return { status: "failed", message: error instanceof Error ? error.message : String(error) };
    } finally {
      activeQuery?.close();
    }
  }
}
