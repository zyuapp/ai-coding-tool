import { query, type CanUseTool, type Query } from "@anthropic-ai/claude-agent-sdk";
import type { Continuation, ExecutionPolicy, ToolIntent } from "../../domain/run.js";
import type { AgentProvider, ProviderEvent, ProviderResult, ProviderRunInput } from "./agent-provider.mjs";

type QueryFactory = typeof query;

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

export class ClaudeAgentProvider implements AgentProvider {
  constructor(private readonly queryFactory: QueryFactory = query) {}

  async execute(input: ProviderRunInput): Promise<ProviderResult> {
    let activeQuery: Query | null = null;
    const canUseTool: CanUseTool = async (toolName, toolInput, options) => {
      const intent = normalizeToolIntent(toolName, toolInput, options.toolUseID);
      const decision = await input.authorize(intent);
      return decision === "allow"
        ? { behavior: "allow", updatedInput: toolInput, toolUseID: options.toolUseID }
        : { behavior: "deny", message: "The user denied this action.", toolUseID: options.toolUseID };
    };

    try {
      const continuation = input.continuation?.provider === "claude" ? input.continuation.value : undefined;
      activeQuery = this.queryFactory({
        prompt: input.prompt,
        options: {
          cwd: input.workspaceRoot,
          resume: continuation,
          permissionMode: claudePermissionMode(input.policy),
          ...(input.model === "default" ? {} : { model: input.model }),
          ...(input.contextWindow === "1m" ? { betas: ["context-1m-2025-08-07" as const] } : {}),
          settingSources: input.projectless ? ["user"] : ["user", "project", "local"],
          skills: "all",
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
        } else if (message.type === "assistant") {
          for (const block of message.message.content) {
            if (block.type === "text" && block.text.trim()) {
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
            limit: input.contextWindow === "1m" ? 1_000_000 : 200_000,
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
