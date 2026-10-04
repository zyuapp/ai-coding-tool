import { AppServerError, CLIENT_INFO, codexAppServer, type ClientParams } from "./app-server-client.mjs";
import type { CodexClient, CodexConnect } from "./codex-session.mjs";

/** Where a thread's work belongs, as Codex records it beside the thread. */
export type ReadOrigin = (root: string) => Promise<{ originUrl: string | null; branch: string | null; sha: string | null }>;

/**
 * What Codex keeps on disk about a thread, as this app leaves it: the title the thread carries here,
 * and the checkout its work belongs to. Codex writes the rollout these are recorded against lazily at
 * the first turn, so everything is held until `began` says the thread has one.
 */
export class CodexThreadRecord {
  private client: CodexClient | null = null;
  private threadId: string | null = null;
  private root: string | null = null;
  private recorded = false;
  private stamped = false;
  /** The title waiting to reach Codex, and the last one that did, so a repeat costs no request. */
  private pending: string | null = null;
  private written: string | null = null;

  constructor(private readonly readOrigin: ReadOrigin) {}

  /** The thread now exists on the server, though Codex may still have nothing on disk for it. */
  opened(client: CodexClient, threadId: string, root: string) {
    this.client = client;
    this.threadId = threadId;
    this.root = root;
  }

  /** Codex has written the rollout, which is what the requests below are recorded against. */
  began() {
    if (this.recorded) return;
    this.recorded = true;
    this.write();
    this.stamp();
  }

  /** Names the thread in Codex's history. A title that lands before the rollout waits for it. */
  label(title: string) {
    if (title === this.written) return;
    this.pending = title;
    this.write();
  }

  private write() {
    const { client, threadId, pending } = this;
    if (!client || !threadId || !this.recorded || pending === null) return;
    this.pending = null;
    this.written = pending;
    void client.request("thread/name/set", { threadId, name: pending }).catch(() => {
      /** A name is a courtesy to the other app; failing to leave one changes nothing here. */
      if (this.written === pending) this.written = null;
    });
  }

  /**
   * Records where the work belongs, so Codex reads a worktree thread as the repository's rather than
   * as a stray folder's. Written once: the checkout does not move under a thread.
   */
  private stamp() {
    const { client, threadId, root } = this;
    if (!client || !threadId || !root || this.stamped) return;
    this.stamped = true;
    void (async () => {
      const gitInfo = await this.readOrigin(root);
      if (!gitInfo.originUrl && !gitInfo.branch && !gitInfo.sha) return;
      await client.request("thread/metadata/update", { threadId, gitInfo });
    })().catch(() => {});
  }
}

/**
 * Continues a thread from disk. A thread archived in another Codex client is out of the live sessions
 * a resume looks in, so an unarchive is offered once before the refusal is passed on.
 */
export async function resumeThread(client: CodexClient, threadId: string, settings: Omit<ClientParams<"thread/resume">, "threadId">) {
  const resume = () => client.request("thread/resume", { threadId, ...settings, excludeTurns: true });
  try {
    return await resume();
  } catch (error) {
    if (!(error instanceof AppServerError)) throw error;
    const unarchived = await client.request("thread/unarchive", { threadId }).then(() => true).catch(() => false);
    if (!unarchived) throw error;
    return await resume();
  }
}

const FILE_TIMEOUT_MS = 60_000;

/**
 * Files a thread away in Codex's history, or brings it back, on a server of its own. Codex refuses
 * while another process still writes the thread, so its session has to be gone first.
 */
export async function fileThread(connect: CodexConnect, threadId: string, archived: boolean) {
  const client = connect(await codexAppServer(["--disable", "plugins", "--disable", "apps", "--disable", "hooks"]));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const filing = (async () => {
      await client.initialize(CLIENT_INFO);
      await client.request(archived ? "thread/archive" : "thread/unarchive", { threadId });
    })();
    const expired = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Codex did not file thread ${threadId} away in time.`)), FILE_TIMEOUT_MS); });
    await Promise.race([filing, expired]);
  } finally {
    clearTimeout(timer);
    await client.close();
  }
}
