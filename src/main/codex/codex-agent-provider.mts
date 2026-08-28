import type { AgentProvider, ProviderResult, ProviderRunInput } from "../agent/agent-provider.mjs";
import { AppServerClient } from "./app-server-client.mjs";
import { CodexSession, type CodexConnect } from "./codex-session.mjs";

/** How long a thread's session waits, with nothing left running under it, before giving its process back. */
const IDLE_SESSION_MS = 15 * 60 * 1_000;
/** How many threads keep a session warm. Beyond this the least recently used idle one is let go. */
const MAX_LIVE_SESSIONS = 4;

/** Everything a session is built with. A run that disagrees with any of it needs a session of its own. */
function sessionKey(input: ProviderRunInput) {
  return JSON.stringify([input.channel, input.workspaceRoot, input.projectless]);
}

function continuationOf(input: ProviderRunInput) {
  return input.continuation?.provider === "codex" ? input.continuation.value : undefined;
}

type Held = {
  session: CodexSession;
  usedAt: number;
  idle?: ReturnType<typeof setTimeout>;
};

export class CodexAgentProvider implements AgentProvider {
  /** One warm session per thread: the process it holds is what makes a second turn cheap. */
  private readonly sessions = new Map<string, Held>();

  constructor(private readonly connect: CodexConnect = (command) => new AppServerClient(command), private readonly idleMs: number = IDLE_SESSION_MS) {}

  async execute(input: ProviderRunInput): Promise<ProviderResult> {
    const held = this.sessionFor(input);
    try {
      return await held.session.run(input);
    } finally {
      this.rest(input.taskId, held);
    }
  }

  /** Codex leaves nothing running behind a turn, so there is never a process of the thread's to stop. */
  stopProcess(_taskId: string, _processId: string) {
    return false;
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
    const session = new CodexSession(key, this.connect, () => {
      if (this.sessions.get(input.taskId)?.session === session) this.sessions.delete(input.taskId);
    });
    const opened: Held = { session, usedAt: Date.now() };
    this.sessions.set(input.taskId, opened);
    return opened;
  }

  /** A session with nothing left to do is kept warm for a while, then handed back. */
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
}
