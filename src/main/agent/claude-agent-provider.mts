import { query, type CanUseTool, type McpServerConfig, type ModelInfo, type Query, type SDKUserMessage, type SlashCommand } from "@anthropic-ai/claude-agent-sdk";
import { claudeEffort, modelTakesEffort, modelsFor, type AgentModel } from "../../domain/agent-engine.js";
import { engineBinaryPath } from "./engine-binary.mjs";
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
/** The ruleset a thread answers under when concise replies are on, alongside the Concise output style. */
const conciseInstructions = `## Persistence

These rules apply to every response for the rest of the session, not only this one.
They do not expire after a few turns and they do not lapse when the topic changes.
If you are unsure whether they still apply, they do.

## Shape

Answer the question that was asked. Lead with the answer, then the reason.

- Five sentences or fewer for prose. Three for a yes/no question, starting with "Yes" or "No".
- One idea per sentence. Active voice. Simple tenses. One word for one thing.
- Cut filler: just, really, basically, actually, "it is important to note".
- State an error matter-of-factly. Never "Uh oh", "Oh no", or "There seems to be a problem". Give the cause, then the fix.
- No binary contrast. "Not X, it's Y", "Not just X but Y", "Not a X. Not a Y. A Z." State Y directly.

## Claims

Name the source or cut the claim. "The docs suggest", "experts agree", "studies show",
and "it is widely regarded" are not evidence. Quote the line, give the path, or say
plainly that you have not verified it.

## Lists

- Three or more parallel items: use a bulleted list, one line each.
- Steps that happen in order: use a numbered list.
- Three or more things compared on the same dimensions: use a table with a header row.
- One or two items, or a single point: use prose. Never write a list of one.
- Cap a list at five items. Past five, split into "do now" and "later", or "must" and "nice to have".

The five-sentence limit applies to prose. A list replaces that prose, so its items
do not each count as a sentence. Keep each item to one line. Do not start a bullet
with a bold label and colon that repeats the rest of the line.

## Never compress

- Error messages, failing test output, security warnings, destructive-action confirmations.
- Code blocks, commands, paths, identifiers.

## When a rule fights the task, the task wins and the shape stays

- The user asks to expand, elaborate, or walk through something: drop the limit for that answer. Resume it on the next question.
- The user asks what their options are: give two to four ranked options with one-line trade-offs, recommendation first. The options are the answer.
- Three turns of "still broken": stop iterating on code. Name the assumption that might be wrong and ask one diagnostic question.

## Pre-send check

Delete before sending:

1. An opener that announces what you are about to do, or flatters you as the lone expert. Cut "Great question", "Let me...", "Sure!", "To answer your question...", "What most people get wrong", "Here's what nobody tells you", "The part everyone misses".
2. A closer that asks "anything else?", recaps what just happened, or lands a cute final line. Cut "Hope this helps", "Let me know if you need anything else". Delete the kicker and end on the clearest concrete sentence already written.
3. Metadiscourse that tells the reader how to read the answer: "The key point is", "That matters more than it sounds", "This distinction matters", "As you can see", "In other words". If the point is clear, delete it. If it is not, replace it with the fact.
4. Any "by the way" sidebar. Finish the first issue, then offer the second as a separate question.
5. Any hedging adverb that adds no information, and any idiom or figurative phrase. Keep a hedge that carries real uncertainty; replace an idiom with the literal action.`;

async function* idlePrompt() {
  await new Promise<void>(() => {});
}

export async function discoverClaudeCommands(workspaceRoot: string, projectless: boolean, queryFactory: QueryFactory = query): Promise<SlashCommand[]> {
  const session = queryFactory({
    prompt: idlePrompt(),
    options: {
      cwd: workspaceRoot,
      pathToClaudeCodeExecutable: claudeExecutable(),
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
function sessionKey(input: ProviderRunInput) {
  return JSON.stringify([
    input.channel,
    input.workspaceRoot,
    input.projectless,
    input.policy === "bypass",
    input.computerUse.status === "available" ? input.computerUse.mcp : input.computerUse.status,
    Boolean(input.claude?.chromeBrowser),
    Boolean(input.claude?.conciseReplies),
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
        pathToClaudeCodeExecutable: claudeExecutable(),
        disallowedTools: withheldTools(input.channel),
        resume: continuation,
        ...(input.forkContinuation && continuation ? { forkSession: true } : {}),
        permissionMode: claudePermissionMode(input.policy),
        ...(input.policy === "bypass" ? { allowDangerouslySkipPermissions: true } : {}),
        model: input.model,
        ...(modelTakesEffort(input.model) ? { effort: claudeEffort(input.effort) } : {}),
        betas: ["context-1m-2025-08-07" as const],
        ...(input.claude?.chromeBrowser ? { extraArgs: { chrome: null } } : {}),
        ...(Object.keys(mcpServers).length ? { mcpServers } : {}),
        systemPrompt: { type: "preset" as const, preset: "claude_code" as const, append: [...(input.computerUse.status === "unavailable" ? [] : [computerUseInstructions]), linkInstructions, ...(input.automations ? [automationInstructions] : []), ...(input.threads ? [threadInstructions] : []), ...(input.browser ? [browserInstructions] : []), ...(input.claude?.chromeBrowser ? [chromeInstructions] : []), ...(input.claude?.conciseReplies ? [conciseInstructions] : [])].join("\n\n") },
        settingSources: (input.projectless ? ["user"] : ["user", "project", "local"]) as ("user" | "project" | "local")[],
        ...(input.claude?.conciseReplies ? { settings: { outputStyle: "Concise" } } : {}),
        skills: "all" as const,
        forwardSubagentText: true,
        includePartialMessages: true,
        canUseTool,
      },
    };
  }
}
