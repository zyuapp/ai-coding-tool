import { createSdkMcpServer, query, tool, type CanUseTool, type McpServerConfig, type Query, type SlashCommand } from "@anthropic-ai/claude-agent-sdk";
import { existsSync } from "node:fs";
import path from "node:path";
import { contextWindowLimit } from "../../domain/run.js";
import type { Continuation, ExecutionPolicy, ToolIntent } from "../../domain/run.js";
import type { AgentProvider, ProviderEvent, ProviderResult, ProviderRunInput } from "./agent-provider.mjs";
import { automationServer, AUTOMATION_SERVER_NAME } from "./automation-tools.mjs";

type QueryFactory = typeof query;
const setupToolName = "mcp__claudex-computer-use__request_setup";
const automationInstructions = `This task can schedule itself. When the user asks to repeat, babysit, poll, or watch something on a cadence, use the claudex-automation tools instead of looping yourself or reaching for cron. An automation runs the same prompt on its own schedule with no user present, so write the prompt to stand alone and carry its own stop condition. When a scheduled run is what is executing and that stop condition is met, call the stop tool; nothing else ends an automation.`;
const computerUseInstructions = `When a requested outcome lives in another application's interface, use the provided computer-use MCP tools. Never invoke a separately installed cua-driver through Bash. Observe the exact target before every action and verify the result afterward. Prefer accessibility targets, then screenshot coordinates, and use foreground delivery only after background delivery fails. If only request_setup is available, call it instead of telling the user to install or configure anything.`;

async function* idlePrompt() {
  await new Promise<void>(() => {});
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

function normalizeToolIntent(toolName: string, input: unknown, toolUseID: string): ToolIntent {
  const writePath = writePathFor(toolName, input);
  return { toolId: toolUseID, name: toolName, input, ...(writePath === undefined ? {} : { writePath }) };
}

type MarkdownBuffer = {
  text: string;
  scanned: number;
  fence?: { marker: string; length: number };
};

function appendCompleteMarkdown(buffer: MarkdownBuffer, text: string) {
  buffer.text += text;
  let safeEnd = 0;
  let lineStart = buffer.scanned;
  while (lineStart < buffer.text.length) {
    const newline = buffer.text.indexOf("\n", lineStart);
    if (newline === -1) break;
    const line = buffer.text.slice(lineStart, newline);
    const marker = line.match(/^(?:\s*>\s*)*\s*(?:(?:[-+*]|\d+[.)])\s+)?(`{3,}|~{3,})([\s\S]*)$/);
    if (!buffer.fence && marker) {
      buffer.fence = { marker: marker[1]![0]!, length: marker[1]!.length };
    } else if (buffer.fence && marker && marker[1]![0] === buffer.fence.marker && marker[1]!.length >= buffer.fence.length && !marker[2]!.trim()) {
      buffer.fence = undefined;
      safeEnd = newline + 1;
    } else if (!buffer.fence && line.trim() === "") {
      safeEnd = newline + 1;
    }
    lineStart = newline + 1;
  }
  buffer.scanned = lineStart;
  if (!safeEnd) return "";
  const complete = buffer.text.slice(0, safeEnd);
  buffer.text = buffer.text.slice(safeEnd);
  buffer.scanned -= safeEnd;
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
      if (toolName === setupToolName) return { behavior: "allow", updatedInput: toolInput, toolUseID: options.toolUseID };
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
      activeQuery = this.queryFactory({
        prompt: input.prompt,
        options: {
          cwd: input.workspaceRoot,
          pathToClaudeCodeExecutable: packagedClaudeExecutable(),
          resume: continuation,
          ...(input.forkContinuation && continuation ? { forkSession: true } : {}),
          permissionMode: input.channel === "side" ? "plan" : claudePermissionMode(input.policy),
          ...(input.channel === "side" ? { tools: ["Read", "Grep", "Glob"] } : {}),
          ...(input.model === "default" ? {} : { model: input.model }),
          ...(input.contextWindow === "1m" ? { betas: ["context-1m-2025-08-07" as const] } : {}),
          ...(Object.keys(mcpServers).length ? { mcpServers } : {}),
          systemPrompt: { type: "preset", preset: "claude_code", append: input.automations ? `${computerUseInstructions}\n\n${automationInstructions}` : computerUseInstructions },
          settingSources: input.projectless ? ["user"] : ["user", "project", "local"],
          skills: "all",
          forwardSubagentText: true,
          includePartialMessages: true,
          canUseTool,
          abortController: input.abortController,
        },
      });

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
          streamedText.set(activeMainStreamId, { text: "", scanned: 0 });
        } else if (message.type === "stream_event" && !message.parent_tool_use_id && activeMainStreamId && message.event.type === "content_block_delta" && message.event.delta.type === "text_delta") {
          const buffered = streamedText.get(activeMainStreamId);
          const complete = buffered ? appendCompleteMarkdown(buffered, message.event.delta.text) : "";
          if (complete) input.emit({ type: "assistant", messageId: activeMainStreamId, text: complete, append: true });
        } else if (message.type === "assistant") {
          const subagentId = message.parent_tool_use_id ? subagentByToolUse.get(message.parent_tool_use_id) : undefined;
          if (subagentId) {
            for (const block of message.message.content) {
              if (block.type === "text" && block.text.trim()) {
                input.emit({ type: "subagent.activity", id: subagentId, activityId: `${message.uuid}:text`, kind: "text", text: block.text });
              } else if (block.type === "tool_use") {
                input.emit({ type: "subagent.activity", id: subagentId, activityId: block.id, kind: "tool", title: block.name, text: JSON.stringify(block.input, null, 2) });
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
            limit: contextWindowLimit(input.contextWindow),
            model: message.message.model,
          });
        } else if (message.type === "result" && (message.subtype !== "success" || message.is_error)) {
          return { status: "failed", message: message.subtype === "success" ? message.result : message.errors.join("\n") };
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
