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

  constructor(options: OpenCodeProviderOptions = {}) {
    this.connect = options.connect ?? startOpenCodeServer;
    this.host = options.host ?? new McpHttpHost();
    this.pool = options.pool ?? new SessionPool(options.idleMs);
  }

  execute(input: ProviderRunInput): Promise<ProviderResult> {
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

  /** Files the session away in OpenCode's own history too, or brings it back, on a server started for that alone. */
  archiveThread(_taskId: string, continuation: Continuation | undefined, archived: boolean) {
    if (continuation?.provider !== "opencode") return false;
    void (async () => {
      const client = await this.connect({ cwd: process.cwd() });
      try {
        await client.request("PATCH", `/api/session/${continuation.value}`, { archived });
      } finally {
        await client.close();
      }
    })().catch(() => {});
    return true;
  }

  closeAll() {
    this.pool.closeAll();
  }
}
