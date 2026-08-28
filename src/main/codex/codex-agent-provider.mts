import type { AgentProvider, ProviderResult, ProviderRunInput } from "../agent/agent-provider.mjs";
import { SessionPool } from "../agent/session-pool.mjs";
import { McpHttpHost, type ToolHost } from "../tools/mcp-http-host.mjs";
import { connectAppServer } from "./app-server-client.mjs";
import { CodexSession, type CodexConnect } from "./codex-session.mjs";

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
    input.computerUse.status === "available" ? [input.computerUse.mcp, input.channel === "main" && input.policy === "autonomous"] : input.computerUse.status,
    Boolean(input.automations),
    Boolean(input.findings),
    Boolean(input.threads),
    Boolean(input.browser),
    Boolean(input.terminal),
  ]);
}

export type CodexProviderOptions = {
  connect?: CodexConnect;
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

  constructor(options: CodexProviderOptions = {}) {
    this.connect = options.connect ?? connectAppServer;
    this.host = options.host ?? new McpHttpHost();
    this.pool = options.pool ?? new SessionPool(options.idleMs);
  }

  execute(input: ProviderRunInput): Promise<ProviderResult> {
    const key = sessionKey(input);
    return this.pool.execute(input, key, { open: ({ ended }) => new CodexSession(key, this.connect, this.host, ended) });
  }

  /** Codex leaves nothing running behind a turn, so there is never a process of the thread's to stop. */
  stopProcess(_taskId: string, _processId: string) {
    return false;
  }

  closeAll() {
    this.pool.closeAll();
  }
}
