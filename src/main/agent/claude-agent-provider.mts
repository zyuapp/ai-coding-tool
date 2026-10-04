import { query, type CanUseTool, type McpServerConfig, type ModelInfo, type Options, type Query, type SDKUserMessage, type SlashCommand } from "@anthropic-ai/claude-agent-sdk";
import { claudeEffort, modelTakesEffort, modelsFor, type AgentModel } from "../../domain/agent-engine.js";
import { engineBinaryPath } from "./engine-binary.mjs";
import { continuationOf, type AgentProvider, type ProviderResult, type ProviderRunInput } from "./agent-provider.mjs";
import { withheldTools } from "./channel-tools.mjs";
import { claudeMcpServer } from "./claude-mcp-host.mjs";
import { claudePermissionMode, ClaudeSession } from "./claude-session.mjs";
import { grantsTool } from "./approval-grant.mjs";
import { runBrief, type BriefDialect, type RunBrief } from "./run-brief.mjs";
import { COORDINATOR_WITHHELD_TOOLS } from "./coordination-instructions.mjs";
import { SessionPool } from "./session-pool.mjs";
import { APP_PLUGIN_NAME, appPluginRoot, unqualifiedSkillName } from "../app-plugin.mjs";

type QueryFactory = typeof query;
const CLAUDE_DIALECT: BriefDialect = { nativeWork: "Claude background tasks, sessions, or agents; native TaskOutput, Agent, and SendMessage cannot access them" };
const chromeInstructions = `The user's own Chrome answers the mcp__claude-in-chrome__ tools, and those tools drive the windows and tabs they already have on screen: when they ask for the external browser, for their browser, or for Chrome by name, use them rather than the AICodingTool browser panel or an open command through Bash. Everything else stays in the panel, which reads a page without disturbing what the user is looking at.`;

async function* idlePrompt() {
  await new Promise<void>(() => {});
}

/** The app's own plugin, when the main process has said where it is. */
function appPlugins() {
  const root = appPluginRoot();
  return root === undefined ? {} : { plugins: [{ type: "local" as const, path: root }] };
}

/** Claude qualifies a plugin skill as `plugin:skill`; the app's own skills are offered by their alias. */
function appCommand(command: SlashCommand): SlashCommand {
  if (!command.name.startsWith(`${APP_PLUGIN_NAME}:`)) return command;
  const { aliases: _aliases, ...rest } = command;
  return { ...rest, name: unqualifiedSkillName(command.name), description: command.description.replace(`(${APP_PLUGIN_NAME}) `, "") };
}

export async function discoverClaudeCommands(workspaceRoot: string, projectless: boolean, queryFactory: QueryFactory = query): Promise<SlashCommand[]> {
  const session = queryFactory({
    prompt: idlePrompt(),
    options: {
      cwd: workspaceRoot,
      pathToClaudeCodeExecutable: claudeExecutable(),
      settingSources: projectless ? ["user"] : ["user", "project", "local"],
      skills: "all",
      ...appPlugins(),
    },
  });
  try {
    return (await session.supportedCommands()).map(appCommand);
  } finally {
    session.close();
  }
}

/**
 * The Claude Code the user installed. The SDK ships a copy of its own, but the app does not carry it:
 * without an explicit path the SDK looks for that copy and refuses to start when it is not there.
 */
export function claudeExecutable() {
  return engineBinaryPath("claude");
}

/**
 * Which catalogue models the installed Claude Code can actually run, asked of the command itself so
 * no version number has to be written down per model. Nothing means it runs all of them, which is
 * what an older command that cannot answer at all is given the benefit of.
 */
export async function discoverClaudeModels(queryFactory: QueryFactory = query): Promise<AgentModel[] | undefined> {
  let session: Query | undefined;
  try {
    session = queryFactory({ prompt: idlePrompt(), options: { pathToClaudeCodeExecutable: claudeExecutable() } });
    const offered = (await session.supportedModels()).flatMap(modelNames);
    const supported = modelsFor("claude").map((spec) => spec.id).filter((id) => offered.some((name) => name === id || name.startsWith(`claude-${id}-`)));
    return supported.length > 0 ? supported : undefined;
  } catch {
    return undefined;
  } finally {
    session?.close();
  }
}

/**
 * What a row calls its model, as both the short name a run passes and the full one it resolves to.
 * A row for a wider context window carries that as a `[1m]` suffix on either name, which names the
 * same model.
 */
function modelNames(info: ModelInfo): string[] {
  return [info.value, info.resolvedModel].filter((name) => name !== undefined).map((name) => name.replace(/\[[^\]]*\]$/, ""));
}

/** Everything a session is built with. A run that disagrees with any of it needs a session of its own. */
function sessionKey(input: ProviderRunInput, brief: RunBrief) {
  return JSON.stringify([...brief.identity, grantsTool("workspace", input), Boolean(input.claude?.chromeBrowser)]);
}

export class ClaudeAgentProvider implements AgentProvider {
  constructor(private readonly queryFactory: QueryFactory = query, private readonly pool = new SessionPool()) {}

  execute(input: ProviderRunInput): Promise<ProviderResult> {
    const brief = runBrief(input, CLAUDE_DIALECT);
    const key = sessionKey(input, brief);
    return this.pool.execute(input, key, {
      open: ({ ended, rested }) => new ClaudeSession(key, ended, rested),
      start: (session) => session.open((prompt, canUseTool, hooks) => this.queryFactory(this.options(input, brief, prompt, canUseTool, hooks)), input),
    });
  }

  /** Reaches the thread's own session, so work that outlived the run that started it can still be stopped. */
  /** Claude keeps no record of its own to name, so the title stays the app's. */
  labelThread() {
    return false;
  }

  stopProcess(taskId: string, processId: string) {
    const session = this.pool.liveSession(taskId);
    if (!(session instanceof ClaudeSession)) return false;
    session.stopProcess(processId);
    return true;
  }

  closeAll() {
    this.pool.closeAll();
  }

  private options(input: ProviderRunInput, brief: RunBrief, prompt: AsyncIterable<SDKUserMessage>, canUseTool: CanUseTool, hooks: Options["hooks"]) {
    const continuation = continuationOf(input);
    const mcpServers: Record<string, McpServerConfig> = {};
    if (input.computerUse.status === "available") {
      mcpServers["cua-driver"] = { type: "stdio" as const, ...input.computerUse.mcp };
    }
    for (const { server, tools } of brief.tools) mcpServers[server] = claudeMcpServer(server, tools);
    return {
      prompt,
      options: {
        cwd: input.workspaceRoot,
        pathToClaudeCodeExecutable: claudeExecutable(),
        disallowedTools: [...withheldTools(input.channel), ...(input.coordinationRole === "coordinator" ? COORDINATOR_WITHHELD_TOOLS : [])],
        resume: continuation,
        ...(input.forkContinuation && continuation ? { forkSession: true } : {}),
        permissionMode: claudePermissionMode(input.policy),
        ...(grantsTool("workspace", input) ? { allowDangerouslySkipPermissions: true } : {}),
        model: input.model,
        ...(modelTakesEffort(input.model) ? { effort: claudeEffort(input.effort) } : {}),
        betas: ["context-1m-2025-08-07" as const],
        ...(input.claude?.chromeBrowser ? { extraArgs: { chrome: null } } : {}),
        ...(Object.keys(mcpServers).length ? { mcpServers } : {}),
        systemPrompt: { type: "preset" as const, preset: "claude_code" as const, append: [...brief.instructions, ...(input.claude?.chromeBrowser ? [chromeInstructions] : [])].join("\n\n") },
        settingSources: (input.projectless ? ["user"] : ["user", "project", "local"]) as ("user" | "project" | "local")[],
        skills: "all" as const,
        ...appPlugins(),
        forwardSubagentText: true,
        includePartialMessages: true,
        canUseTool,
        hooks,
      },
    };
  }
}
