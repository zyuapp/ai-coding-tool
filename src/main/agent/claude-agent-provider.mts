import { query, type CanUseTool, type McpServerConfig, type SDKUserMessage, type SlashCommand } from "@anthropic-ai/claude-agent-sdk";
import { existsSync } from "node:fs";
import path from "node:path";
import { claudeEffort } from "../../domain/agent-engine.js";
import { continuationOf, type AgentProvider, type ProviderResult, type ProviderRunInput } from "./agent-provider.mjs";
import { withheldTools } from "./channel-tools.mjs";
import { claudeMcpServer } from "./claude-mcp-host.mjs";
import { claudePermissionMode, ClaudeSession } from "./claude-session.mjs";
import { runTools } from "./run-tools.mjs";
import { SessionPool } from "./session-pool.mjs";

type QueryFactory = typeof query;
const linkInstructions = `Only Markdown links are clickable in your output. Link web pages as [label](https://example.com), workspace files as [label](/absolute/path:line), and other threads as [title](aicodingtool://thread/<id>). Omit the line when it is unavailable.`;
const browserInstructions = `The AICodingTool browser panel is a real browser sharing one session with the user, so every site they have signed into is signed in for you: use the aicodingtool-browser tools rather than curl or Bash for anything behind a login, and rather than guessing at a page you can read.`;
const chromeInstructions = `The user's own Chrome answers the mcp__claude-in-chrome__ tools, and those tools drive the windows and tabs they already have on screen: when they ask for the external browser, for their browser, or for Chrome by name, use them rather than the AICodingTool browser panel or an open command through Bash. Everything else stays in the panel, which reads a page without disturbing what the user is looking at.`;
const threadInstructions = `AICodingTool holds the user's other threads, and the aicodingtool-threads tools are the only way to reach them: read them rather than answering about them from memory.`;
const automationInstructions = `This task can schedule itself. When the user asks to repeat, babysit, poll, or watch something on a cadence, use the aicodingtool-automation tools instead of looping yourself or reaching for cron.`;
const computerUseInstructions = `When a requested outcome lives in another application's interface, use the provided computer-use MCP tools. Never invoke a separately installed cua-driver through Bash. Observe the exact target before every action and verify the result afterward. Prefer accessibility targets, then screenshot coordinates, and use foreground delivery only after background delivery fails.`;

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

/** Everything a session is built with. A run that disagrees with any of it needs a session of its own. */
function sessionKey(input: ProviderRunInput) {
  return JSON.stringify([
    input.channel,
    input.workspaceRoot,
    input.projectless,
    input.computerUse.status === "available" ? input.computerUse.mcp : input.computerUse.status,
    input.claude?.outputStyle ?? null,
    Boolean(input.claude?.chromeBrowser),
    Boolean(input.automations),
    Boolean(input.findings),
    Boolean(input.threads),
    Boolean(input.browser),
    Boolean(input.terminal),
  ]);
}

export class ClaudeAgentProvider implements AgentProvider {
  constructor(private readonly queryFactory: QueryFactory = query, private readonly pool = new SessionPool()) {}

  execute(input: ProviderRunInput): Promise<ProviderResult> {
    const key = sessionKey(input);
    return this.pool.execute(input, key, {
      open: ({ ended, rested }) => new ClaudeSession(key, ended, rested),
      start: (session) => session.open((prompt, canUseTool) => this.queryFactory(this.options(input, prompt, canUseTool)), input),
    });
  }

  /** Reaches the thread's own session, so work that outlived the run that started it can still be stopped. */
  stopProcess(taskId: string, processId: string) {
    const session = this.pool.liveSession(taskId);
    if (!(session instanceof ClaudeSession)) return false;
    session.stopProcess(processId);
    return true;
  }

  closeAll() {
    this.pool.closeAll();
  }

  private options(input: ProviderRunInput, prompt: AsyncIterable<SDKUserMessage>, canUseTool: CanUseTool) {
    const continuation = continuationOf(input);
    const mcpServers: Record<string, McpServerConfig> = {};
    if (input.computerUse.status === "available") {
      mcpServers["cua-driver"] = { type: "stdio" as const, ...input.computerUse.mcp };
    }
    for (const { server, tools } of runTools(input)) mcpServers[server] = claudeMcpServer(server, tools);
    return {
      prompt,
      options: {
        cwd: input.workspaceRoot,
        pathToClaudeCodeExecutable: packagedClaudeExecutable(),
        disallowedTools: withheldTools(input.channel),
        resume: continuation,
        ...(input.forkContinuation && continuation ? { forkSession: true } : {}),
        permissionMode: claudePermissionMode(input.policy),
        model: input.model,
        effort: claudeEffort(input.effort),
        ...(input.claude?.outputStyle ? { settings: { outputStyle: input.claude.outputStyle } } : {}),
        betas: ["context-1m-2025-08-07" as const],
        ...(input.claude?.chromeBrowser ? { extraArgs: { chrome: null } } : {}),
        ...(Object.keys(mcpServers).length ? { mcpServers } : {}),
        systemPrompt: { type: "preset" as const, preset: "claude_code" as const, append: [...(input.computerUse.status === "unavailable" ? [] : [computerUseInstructions]), linkInstructions, ...(input.automations ? [automationInstructions] : []), ...(input.threads ? [threadInstructions] : []), ...(input.browser ? [browserInstructions] : []), ...(input.claude?.chromeBrowser ? [chromeInstructions] : [])].join("\n\n") },
        settingSources: (input.projectless ? ["user"] : ["user", "project", "local"]) as ("user" | "project" | "local")[],
        skills: "all" as const,
        forwardSubagentText: true,
        includePartialMessages: true,
        canUseTool,
      },
    };
  }
}
