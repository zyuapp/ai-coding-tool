import type { AgentProvider, ProviderResult, ProviderRunInput } from "../agent/agent-provider.mjs";
import { SessionPool } from "../agent/session-pool.mjs";
import { McpHttpHost, type ToolHost } from "../tools/mcp-http-host.mjs";
import { connectAppServer } from "./app-server-client.mjs";
import { CodexSession, type CodexConnect } from "./codex-session.mjs";
import type { ReadOrigin } from "./codex-thread-record.mjs";

/**
 * Everything a session is built with. A run that disagrees with any of it needs a session of its
 * own. Computer use is granted unasked per process, so what decides that grant counts only while
 * computer use is on.
 */
function sessionKey(input: ProviderRunInput) {
  return JSON.stringify([
    input.channel,
    input.workspaceRoot,
    input.projectless,
    input.computerUse.status === "available" ? [input.computerUse.mcp, input.policy === "bypass" || (input.channel === "main" && input.policy === "autonomous")] : input.computerUse.status,
    Boolean(input.automations),
    Boolean(input.findings),
    Boolean(input.threads),
    Boolean(input.browser),
    Boolean(input.terminal),
    /** Review has no turn-level overrides, so its process must agree with the thread settings. */
    input.operation?.type === "review" ? [input.model, input.effort, input.policy] : null,
  ]);
}

/** Where a thread's work belongs, read from the checkout it runs in. */
const readOrigin: ReadOrigin = async (root) => {
  const { currentBranch, headCommit, originUrl } = await import("../workspace/git.mjs");
  const [origin, branch, sha] = await Promise.all([
    originUrl(root).catch(() => null),
    currentBranch(root).catch(() => null),
    headCommit(root).catch(() => null),
  ]);
  return { originUrl: origin, branch, sha };
};

export type CodexProviderOptions = {
  connect?: CodexConnect;
  /** Reads the checkout a thread runs in; a test hands it an answer instead of a repository. */
  readOrigin?: ReadOrigin;
  /** Serves the app's tools to every session; shared across providers in one process. */
  host?: ToolHost;
  /** The sessions this engine's threads keep warm; shared with the other engines of its channel. */
  pool?: SessionPool;
  idleMs?: number;
};

export class CodexAgentProvider implements AgentProvider {
  private readonly connect: CodexConnect;
  private readonly host: ToolHost;
  private readonly pool: SessionPool;
  private readonly readOrigin: ReadOrigin;

  constructor(options: CodexProviderOptions = {}) {
    this.connect = options.connect ?? connectAppServer;
    this.readOrigin = options.readOrigin ?? readOrigin;
    this.host = options.host ?? new McpHttpHost();
    this.pool = options.pool ?? new SessionPool(options.idleMs);
  }

  execute(input: ProviderRunInput): Promise<ProviderResult> {
    const key = sessionKey(input);
    return this.pool.execute(input, key, { open: ({ ended, rested }) => new CodexSession(key, this.connect, this.host, ended, rested, this.readOrigin) });
  }

  /** Reaches the thread's own session, so work that outlived the turn that started it can still be stopped. */
  stopProcess(taskId: string, processId: string) {
    const session = this.pool.liveSession(taskId);
    if (!(session instanceof CodexSession)) return false;
    session.stopProcess(processId);
    return true;
  }

  /** Names the thread in Codex's own history, so it reads there as it reads here. */
  labelThread(taskId: string, title: string) {
    const session = this.pool.liveSession(taskId);
    if (!(session instanceof CodexSession)) return false;
    session.label(title);
    return true;
  }

  closeAll() {
    this.pool.closeAll();
  }
}
