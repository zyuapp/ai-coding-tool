import { createSdkMcpServer, query, tool, type CanUseTool, type McpServerConfig, type SDKUserMessage, type SlashCommand } from "@anthropic-ai/claude-agent-sdk";
import { existsSync } from "node:fs";
import path from "node:path";
import type { AgentProvider, ProviderResult, ProviderRunInput } from "./agent-provider.mjs";
import { automationServer, AUTOMATION_SERVER_NAME } from "./automation-tools.mjs";
import { browserServer, BROWSER_SERVER_NAME } from "./browser-tools.mjs";
import { terminalServer, TERMINAL_SERVER_NAME } from "./terminal-tools.mjs";
import { withheldTools } from "./channel-tools.mjs";
import { threadServer, THREAD_SERVER_NAME } from "./thread-tools.mjs";
import { claudePermissionMode, ClaudeSession } from "./claude-session.mjs";

type QueryFactory = typeof query;
const linkInstructions = `Only Markdown links are clickable in your output. Link web pages as [label](https://example.com) and workspace files as [label](/absolute/path:line). Omit the line when it is unavailable.`;
const browserInstructions = `The Claudex browser panel is a real browser sharing one session with the user, so every site they have signed into is signed in for you: use the claudex-browser tools rather than curl or Bash for anything behind a login, and rather than guessing at a page you can read. Open a page, read it, then act on the refs that read hands you — a ref is stale as soon as the page changes. The user sees the same tabs you drive, so leave their pages alone and close only the tabs you opened. An origin the user has never visited waits on their approval before it loads; say what you need it for instead of retrying.`;
const threadInstructions = `Claudex holds the user's other threads, and the claudex-threads tools are the only way to reach them. Read them with list_threads and read_thread when the user points at other, recent, or related work instead of guessing from memory. Start a thread per piece of work when the user asks for several things to run side by side, and give each one a prompt that stands alone: a new thread inherits none of this conversation. Wait on a thread you started with wait_for_thread rather than polling read_thread. Archiving or stopping a thread throws away work in progress, so only do it when the user asked for it. When you name another thread in an answer, link it as [title](claudex://thread/<id>) so the user can open it from your message. A message that already carries one of those links is naming a thread for you, so read it rather than searching for it.`;
const automationInstructions = `This task can schedule itself. When the user asks to repeat, babysit, poll, or watch something on a cadence, use the claudex-automation tools instead of looping yourself or reaching for cron. An automation runs the same prompt on its own schedule with no user present, so write the prompt to stand alone and carry its own stop condition. When a scheduled run is what is executing and that stop condition is met, call the stop tool; nothing else ends an automation.`;
const computerUseInstructions = `When a requested outcome lives in another application's interface, use the provided computer-use MCP tools. Never invoke a separately installed cua-driver through Bash. Observe the exact target before every action and verify the result afterward. Prefer accessibility targets, then screenshot coordinates, and use foreground delivery only after background delivery fails. If only request_setup is available, call it instead of telling the user to install or configure anything.`;

/** How long a thread's session waits, with nothing left running under it, before giving its process back. */
const IDLE_SESSION_MS = 15 * 60 * 1_000;
/** How many threads keep a session warm. Beyond this the least recently used idle one is let go. */
const MAX_LIVE_SESSIONS = 4;

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
    Boolean(input.automations),
    Boolean(input.threads),
    Boolean(input.browser),
    Boolean(input.terminal),
  ]);
}

function continuationOf(input: ProviderRunInput) {
  return input.continuation?.provider === "claude" ? input.continuation.value : undefined;
}

type Held = {
  session: ClaudeSession;
  usedAt: number;
  idle?: ReturnType<typeof setTimeout>;
};

export class ClaudeAgentProvider implements AgentProvider {
  /** One warm session per thread: the process it holds is what makes a second turn cheap. */
  private readonly sessions = new Map<string, Held>();

  constructor(private readonly queryFactory: QueryFactory = query, private readonly idleMs: number = IDLE_SESSION_MS) {}

  async execute(input: ProviderRunInput): Promise<ProviderResult> {
    const held = this.sessionFor(input);
    try {
      return await held.session.run(input);
    } finally {
      this.rest(input.taskId, held);
    }
  }

  /** Lets every session go, which is what ends the processes they hold. */
  closeAll() {
    for (const held of [...this.sessions.values()]) {
      clearTimeout(held.idle);
      held.session.close();
    }
    this.sessions.clear();
  }

  private sessionFor(input: ProviderRunInput): Held {
    const key = sessionKey(input);
    const held = this.sessions.get(input.taskId);
    const reusable = held?.session.live
      && held.session.key === key
      && !held.session.answering
      && !input.forkContinuation
      && held.session.continues(continuationOf(input));
    if (held && reusable) {
      clearTimeout(held.idle);
      held.idle = undefined;
      held.usedAt = Date.now();
      return held;
    }
    if (held) this.release(input.taskId, held);
    this.evict();
    const session = new ClaudeSession(
      key,
      () => {
        if (this.sessions.get(input.taskId)?.session === session) this.sessions.delete(input.taskId);
      },
      () => {
        const settled = this.sessions.get(input.taskId);
        if (settled?.session === session) this.rest(input.taskId, settled);
      },
    );
    const opened: Held = { session, usedAt: Date.now() };
    this.sessions.set(input.taskId, opened);
    session.open((prompt, canUseTool) => this.queryFactory(this.options(input, prompt, canUseTool)), input);
    return opened;
  }

  /**
   * A session with nothing left to do is kept warm for a while, then handed back. Work the agent left
   * running is not nothing: the deadline finds the session busy and starts over, so a workflow that runs
   * for hours is never on a clock, and the session it holds is still reclaimed once the work stops.
   */
  private rest(taskId: string, held: Held) {
    if (this.sessions.get(taskId) !== held || !held.session.live) return;
    held.usedAt = Date.now();
    clearTimeout(held.idle);
    held.idle = setTimeout(() => (held.session.busy ? this.rest(taskId, held) : this.release(taskId, held)), this.idleMs);
    held.idle.unref?.();
  }

  private release(taskId: string, held: Held) {
    clearTimeout(held.idle);
    if (this.sessions.get(taskId) === held) this.sessions.delete(taskId);
    held.session.close();
  }

  private evict() {
    const idle = [...this.sessions].filter(([, held]) => !held.session.busy).sort(([, left], [, right]) => left.usedAt - right.usedAt);
    for (let over = this.sessions.size - MAX_LIVE_SESSIONS + 1; over > 0 && idle.length; over -= 1) {
      const [taskId, held] = idle.shift()!;
      this.release(taskId, held);
    }
  }

  private options(input: ProviderRunInput, prompt: AsyncIterable<SDKUserMessage>, canUseTool: CanUseTool) {
    const continuation = continuationOf(input);
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
        effort: input.effort,
        betas: ["context-1m-2025-08-07" as const],
        ...(Object.keys(mcpServers).length ? { mcpServers } : {}),
        systemPrompt: { type: "preset" as const, preset: "claude_code" as const, append: [computerUseInstructions, linkInstructions, ...(input.automations ? [automationInstructions] : []), ...(input.threads ? [threadInstructions] : []), ...(input.browser ? [browserInstructions] : [])].join("\n\n") },
        settingSources: (input.projectless ? ["user"] : ["user", "project", "local"]) as ("user" | "project" | "local")[],
        skills: "all" as const,
        forwardSubagentText: true,
        includePartialMessages: true,
        canUseTool,
      },
    };
  }
}
