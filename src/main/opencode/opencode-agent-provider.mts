import type { Continuation } from "../../domain/run.js";
import type { CoordinationRole } from "../../domain/coordination.js";
import type { AgentProvider, ProviderResult, ProviderRunInput } from "../agent/agent-provider.mjs";
import { SessionPool } from "../agent/session-pool.mjs";
import { McpHttpHost, type ToolHost } from "../tools/mcp-http-host.mjs";
import { openCodeBrief } from "./opencode-instructions.mjs";
import { OpenCodeSession } from "./opencode-session.mjs";
import { startOpenCodeServer, type OpenCodeConnect } from "./opencode-server.mjs";

/**
 * Everything a session's server is started with. The model, effort, mode and every tool grant are
 * the session's own to change, so only the instructions and the tools offered count.
 */
function sessionKey(input: ProviderRunInput) {
  return JSON.stringify(openCodeBrief(input).identity);
}

export type OpenCodeProviderOptions = {
  connect?: OpenCodeConnect;
  /** Serves the app's tools to every session; shared across providers in one process. */
  host?: ToolHost;
  /** The sessions this engine's threads keep warm; shared with the other engines of its channel. */
  pool?: SessionPool;
  idleMs?: number;
};

export class OpenCodeAgentProvider implements AgentProvider {
  private readonly connect: OpenCodeConnect;
  private readonly host: ToolHost;
  private readonly pool: SessionPool;
  private readonly filings = new Map<string, Promise<void>>();

  constructor(options: OpenCodeProviderOptions = {}) {
    this.connect = options.connect ?? startOpenCodeServer;
    this.host = options.host ?? new McpHttpHost();
    this.pool = options.pool ?? new SessionPool(options.idleMs);
  }

  async execute(input: ProviderRunInput): Promise<ProviderResult> {
    /** A thread still being filed away or brought back is held by that filing until it lands. */
    await this.filings.get(input.taskId);
    const key = sessionKey(input);
    return this.pool.execute(input, key, { open: ({ ended, rested }) => new OpenCodeSession(key, this.connect, this.host, ended, rested) });
  }

  /** OpenCode's own shells are not listed to the app, so there is nothing of theirs to stop. */
  stopProcess() {
    return false;
  }

  labelThread(taskId: string, title: string) {
    const session = this.pool.liveSession(taskId);
    if (!(session instanceof OpenCodeSession)) return false;
    session.label(title);
    return true;
  }

  retireOutOfRole(taskId: string, role: CoordinationRole | undefined) {
    void this.pool.retireOutOfRole(taskId, role);
  }

  /**
   * Files the session away in OpenCode's own history too, or brings it back: on the thread's own
   * server while it has one, else on one started for that alone. An archived thread's warm session
   * goes with it. Filings of one thread land in the order asked.
   */
  archiveThread(taskId: string, continuation: Continuation | undefined, archived: boolean) {
    if (continuation && continuation.provider !== "opencode") return false;
    const live = this.pool.liveSession(taskId);
    const session = live instanceof OpenCodeSession ? live : undefined;
    const sessionId = continuation?.value ?? session?.sessionId;
    if (!sessionId) return false;
    const previous = this.filings.get(taskId) ?? Promise.resolve();
    const filing = previous
      .then(async () => {
        if (!await session?.file(sessionId, archived)) {
          const client = await this.connect({ cwd: process.cwd() });
          try {
            await client.request("PATCH", `/api/session/${sessionId}`, { archived });
          } finally {
            await client.close();
          }
        }
        if (archived) await this.pool.retire(taskId);
      })
      .catch(() => {})
      .finally(() => { if (this.filings.get(taskId) === filing) this.filings.delete(taskId); });
    this.filings.set(taskId, filing);
    return true;
  }

  closeAll() {
    this.pool.closeAll();
  }
}
