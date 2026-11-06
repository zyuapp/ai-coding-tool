import type { Continuation } from "../../domain/run.js";
import { handleFor, type AgentProvider, type ProviderResult, type ProviderRunInput } from "../agent/agent-provider.mjs";
import { PooledProvider } from "../agent/pooled-provider.mjs";
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

export class OpenCodeAgentProvider extends PooledProvider<OpenCodeSession> implements AgentProvider {
  private readonly connect: OpenCodeConnect;
  private readonly host: ToolHost;

  constructor(options: OpenCodeProviderOptions = {}) {
    super(options.pool ?? new SessionPool(options.idleMs), OpenCodeSession);
    this.connect = options.connect ?? startOpenCodeServer;
    this.host = options.host ?? new McpHttpHost();
  }

  execute(input: ProviderRunInput): Promise<ProviderResult> {
    const key = sessionKey(input);
    return this.run(input, key, { open: ({ ended, rested }) => new OpenCodeSession(key, this.connect, this.host, ended, rested) });
  }

  /** OpenCode's own shells are not listed to the app, so there is nothing of theirs to stop. */
  stopProcess() {
    return false;
  }

  labelThread(taskId: string, title: string) {
    const session = this.session(taskId);
    session?.label(title);
    return Boolean(session);
  }

  /**
   * Files the session away in OpenCode's own history too, or brings it back: on the thread's own
   * server while it has one, else on one started for that alone. An archived thread's warm session
   * goes with it. Filings of one thread land in the order asked.
   */
  archiveThread(taskId: string, continuation: Continuation | undefined, archived: boolean) {
    const handle = handleFor(continuation, "opencode");
    if (continuation && !handle) return false;
    const session = this.session(taskId);
    const sessionId = handle ?? session?.sessionId;
    if (!sessionId) return false;
    this.file(taskId, async () => {
      if (!await session?.file(sessionId, archived)) {
        const client = await this.connect({ cwd: process.cwd() });
        try {
          await client.request("PATCH", `/api/session/${sessionId}`, { archived });
        } finally {
          await client.close();
        }
      }
      if (archived) await this.pool.retire(taskId);
    });
    return true;
  }
}
