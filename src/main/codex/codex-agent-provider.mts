import type { Continuation } from "../../domain/run.js";
import { handleFor, type AgentProvider, type ProviderResult, type ProviderRunInput } from "../agent/agent-provider.mjs";
import { grantsTool } from "../agent/approval-grant.mjs";
import { PooledProvider } from "../agent/pooled-provider.mjs";
import { SessionPool } from "../agent/session-pool.mjs";
import { McpHttpHost, type ToolHost } from "../tools/mcp-http-host.mjs";
import { connectAppServer } from "./app-server-client.mjs";
import { CodexSession, type CodexConnect } from "./codex-session.mjs";
import { fileThread, type ReadOrigin } from "./codex-thread-record.mjs";
import { codexImageOutput, type ImageOutput } from "./codex-images.mjs";
import { codexBrief } from "./codex-instructions.mjs";

/**
 * Everything a session is built with. A run that disagrees with any of it needs a session of its
 * own. App tools and computer use are granted unasked per process, so what decides those grants
 * counts too; computer use's only while it is on.
 */
function sessionKey(input: ProviderRunInput) {
  return JSON.stringify([
    ...codexBrief(input).identity,
    input.computerUse.status === "available" && grantsTool("computer-use", input),
    grantsTool("workspace", input),
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
  imageOutput?: ImageOutput;
  connect?: CodexConnect;
  /** Reads the checkout a thread runs in; a test hands it an answer instead of a repository. */
  readOrigin?: ReadOrigin;
  /** Serves the app's tools to every session; shared across providers in one process. */
  host?: ToolHost;
  /** The sessions this engine's threads keep warm; shared with the other engines of its channel. */
  pool?: SessionPool;
  idleMs?: number;
};

export class CodexAgentProvider extends PooledProvider<CodexSession> implements AgentProvider {
  private readonly connect: CodexConnect;
  private readonly host: ToolHost;
  private readonly readOrigin: ReadOrigin;
  private readonly imageOutput: ImageOutput;

  constructor(options: CodexProviderOptions = {}) {
    super(options.pool ?? new SessionPool(options.idleMs), CodexSession);
    this.connect = options.connect ?? connectAppServer;
    this.readOrigin = options.readOrigin ?? readOrigin;
    this.imageOutput = options.imageOutput ?? codexImageOutput;
    this.host = options.host ?? new McpHttpHost();
  }

  execute(input: ProviderRunInput): Promise<ProviderResult> {
    const key = sessionKey(input);
    return this.run(input, key, { open: ({ ended, rested }) => new CodexSession(key, this.connect, this.host, ended, rested, this.readOrigin, this.imageOutput) });
  }

  /** Reaches the thread's own session, so work that outlived the turn that started it can still be stopped. */
  stopProcess(taskId: string, processId: string) {
    const session = this.session(taskId);
    session?.stopProcess(processId);
    return Boolean(session);
  }

  /** Names the thread in Codex's own history, so it reads there as it reads here. */
  labelThread(taskId: string, title: string) {
    const session = this.session(taskId);
    session?.label(title);
    return Boolean(session);
  }

  /**
   * Files the thread away in Codex's own history too, or brings it back. Archiving waits out the
   * thread's session, which holds the thread open until its cancelled turn has answered; a thread
   * archived before Codex named it is filed under the name its session ends up with.
   */
  archiveThread(taskId: string, continuation: Continuation | undefined, archived: boolean) {
    const handle = handleFor(continuation, "codex");
    if (continuation && !handle) return false;
    const session = this.session(taskId);
    if (!handle && !(archived && session)) return false;
    this.file(taskId, async () => {
      if (archived) await this.pool.retire(taskId);
      const threadId = handle ?? session?.threadId;
      if (threadId) await fileThread(this.connect, threadId, archived);
    });
    return true;
  }
}
