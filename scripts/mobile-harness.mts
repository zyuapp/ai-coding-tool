/**
 * The phone page, driven by a pretend Mac. Vite serves the page with hot reload and this stands in
 * for the bridge: it answers the same wire messages the real server answers, out of invented state,
 * so the phone screen can be worked on without Electron, without pairing and without a phone.
 *
 * It is a stand-in, not a second implementation. Nothing here is imported by the app.
 */
import { createServer } from "node:http";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { createServer as createViteServer } from "vite";
import { WebSocketServer, type WebSocket } from "ws";
import {
  MOBILE_PROTOCOL_VERSION,
  isMobileClientMessage,
  type MobileClientMessage,
  type MobileCommand,
  type MobileServerMessage,
  type MobileThreadView,
  type MobileView,
} from "../src/contracts/mobile.ts";
import { MOBILE_APP_PATH } from "../src/domain/mobile.ts";

/** A plain `Omit` over a union collapses it to the fields they share. This keeps the arms apart. */
type Unsequenced<T> = T extends unknown ? Omit<T, "sequence"> : never;

const ROOT = path.resolve(import.meta.dirname, "..");
const PORT = Number(process.env.MOBILE_HARNESS_PORT ?? 7738);
const SOCKET_PATH = `${MOBILE_APP_PATH}/socket`;
/** The one code this harness accepts, so the link it prints keeps working across restarts. */
const CODE = "HARNESS0";

/**
 * The page's own policy admits the built script by its hash. Nothing is built here, and the dev
 * server adds a script of its own for reloading, so the policy comes off rather than being widened
 * to something the real page would never ship.
 */
const CSP_META = /<meta http-equiv="Content-Security-Policy"[^>]*>/;

const NOW = Date.parse("2026-08-24T09:00:00Z");

function thread(id: string, title: string, minutesAgo: number, status: MobileView["groups"][number]["threads"][number]["status"], unread = false) {
  return { id, title, status, lastActivityAt: NOW - minutesAgo * 60_000, unread };
}

const OPEN_THREAD: MobileThreadView = {
  id: "task-1",
  title: "Let a phone drive the app",
  projectName: "ai-coding-tool",
  omitted: 12,
  streamingTail: null,
  status: "awaiting-approval",
  queued: [{ id: "queued-1", text: "Then run the whole suite once more." }],
  prompt: "",
  settings: { model: "opus", effort: "high", policy: "allow-edits" },
  approval: {
    approvalId: "approval-1",
    runId: "run-1",
    title: "Run a command",
    description: "npm run check",
    toolName: "Bash",
    detail: "npm run check\n\nRuns three type-checks and lint over the whole repo.",
  },
  messages: [
    { kind: "user", text: "Check the phone page builds and the tests still pass.", at: NOW - 9 * 60_000 },
    { kind: "assistant", text: "Reading the build config first.\n\nThe phone page is built by its own config into `dist/mobile`, folded into **one file** so the server never has to guess an asset path.", at: NOW - 8 * 60_000 },
    { kind: "tool", text: "Read vite.mobile.config.mts", at: NOW - 8 * 60_000 },
    { kind: "assistant", text: "That looks right. I want to run the checks before I say so.", at: NOW - 7 * 60_000 },
  ],
};

const VIEW: MobileView = {
  error: null,
  thread: OPEN_THREAD,
  groups: [
    {
      projectId: "project-1",
      name: "ai-coding-tool",
      threads: [
        thread("task-1", "Let a phone drive the app", 7, "awaiting-approval", true),
        thread("task-2", "Show the wait while a worktree is deleted", 52, "idle"),
        thread("task-3", "Put the count of unseen threads on the app icon", 190, "running", true),
      ],
    },
    { projectId: "project-2", name: "just-notes", threads: [thread("task-4", "Search completed transcripts", 1_500, "stopped")] },
    { projectId: null, name: "Recents", threads: [] },
  ],
};

/** One pretend Mac per socket, so reloading the page starts clean. */
class Stand {
  private sequence = 0;
  private view: MobileView = structuredClone(VIEW);
  private paired = false;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly socket: WebSocket;

  constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on("message", (raw) => this.receive(raw.toString()));
    socket.on("close", () => this.stop());
  }

  private send(message: Unsequenced<MobileServerMessage>) {
    this.sequence += 1;
    this.socket.send(JSON.stringify({ ...message, sequence: this.sequence } as MobileServerMessage));
  }

  private later(ms: number, work: () => void) {
    const timer = setTimeout(() => { this.timers.delete(timer); work(); }, ms);
    this.timers.add(timer);
  }

  private stop() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  private receive(text: string) {
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      this.send({ kind: "error", code: "unreadable", message: "That was not readable." });
      return;
    }
    if (!isMobileClientMessage(message)) {
      this.send({ kind: "error", code: "unreadable", message: "That was not a message this bridge knows." });
      return;
    }
    this.handle(message);
  }

  private handle(message: MobileClientMessage) {
    if (message.kind === "pong") return;
    if (message.kind === "pair") {
      if (message.version !== MOBILE_PROTOCOL_VERSION) return this.send({ kind: "error", code: "version", message: "This page is out of date." });
      if (message.code.toUpperCase() !== CODE) return this.send({ kind: "error", code: "expired-code", message: `The harness only accepts ${CODE}.` });
      this.send({ kind: "paired", deviceId: "device-harness", deviceName: message.deviceName, token: "harness-token" });
      this.open();
      return;
    }
    if (message.kind === "resume") {
      if (message.token !== "harness-token") return this.send({ kind: "error", code: "unauthorized", message: "The harness forgot that token. Open the pairing link again." });
      this.open();
      return;
    }
    this.command(message.requestId, message.command);
  }

  private open() {
    this.paired = true;
    this.send({ kind: "snapshot", sessionId: "session-harness", view: this.view });
  }

  private command(requestId: string, command: MobileCommand) {
    if (!this.paired) return this.send({ kind: "ack", requestId, ok: false, message: "Pair first." });
    this.send({ kind: "ack", requestId, ok: true });
    const open = this.view.thread;
    if (!open) return;

    if (command.type === "view.set-prompt") {
      open.prompt = command.prompt;
      return this.send({ kind: "patch", patch: { thread: { kind: "changed", id: open.id, delta: { prompt: command.prompt } } } });
    }

    if (command.type === "run.decide") {
      open.approval = null;
      open.status = command.allow ? "running" : "idle";
      this.send({ kind: "patch", patch: { thread: { kind: "changed", id: open.id, delta: { approval: null, status: open.status } } } });
      if (command.allow) this.pretendToWork("The checks pass: 85 files, 1052 tests, nothing failing.");
      return;
    }

    if (command.type === "run.cancel") {
      open.status = "stopped";
      open.streamingTail = null;
      return this.send({ kind: "patch", patch: { thread: { kind: "changed", id: open.id, delta: { status: "stopped", streamingTail: null } } } });
    }

    if (command.type === "task.send") {
      const text = command.text ?? open.prompt;
      if (!text.trim()) return;
      const sent = { kind: "user" as const, text, at: Date.now() };
      open.messages.push(sent);
      open.prompt = "";
      open.status = "running";
      this.send({ kind: "patch", patch: { thread: { kind: "changed", id: open.id, delta: { appended: [sent], prompt: "", status: "running" } } } });
      return this.pretendToWork(`I read that as: "${text.trim()}". This is the harness, so nothing actually ran.`);
    }

    if (command.type === "task.select") {
      const picked = this.view.groups.flatMap((group) => group.threads).find((entry) => entry.id === command.taskId);
      if (!picked || picked.id === open.id) return;
      const next: MobileThreadView = {
        ...structuredClone(OPEN_THREAD),
        id: picked.id,
        title: picked.title,
        status: picked.status,
        approval: null,
        queued: [],
        prompt: "",
        messages: [{ kind: "assistant", text: `This is the harness standing in for **${picked.title}**.`, at: Date.now() }],
        omitted: 0,
      };
      this.view.thread = next;
      return this.send({ kind: "patch", patch: { thread: { kind: "opened", thread: next } } });
    }

    if (command.type === "task.set-model" || command.type === "task.set-effort" || command.type === "task.set-policy") {
      const settings = { ...open.settings, ...("model" in command ? { model: command.model } : {}), ...("effort" in command ? { effort: command.effort } : {}), ...("policy" in command ? { policy: command.policy } : {}) };
      open.settings = settings;
      return this.send({ kind: "patch", patch: { thread: { kind: "changed", id: open.id, delta: { settings } } } });
    }
  }

  /** A reply typed out a word at a time, which is the only way to see the streaming end on screen. */
  private pretendToWork(reply: string) {
    const open = this.view.thread;
    if (!open) return;
    const words = reply.split(" ");
    words.forEach((word, index) => {
      this.later(120 * (index + 1), () => {
        const tail = words.slice(0, index + 1).join(" ");
        open.streamingTail = tail;
        this.send({ kind: "patch", patch: { thread: { kind: "changed", id: open.id, delta: { streamingTail: tail } } } });
      });
    });
    this.later(120 * (words.length + 2), () => {
      const done = { kind: "assistant" as const, text: reply, at: Date.now() };
      open.messages.push(done);
      open.streamingTail = null;
      open.status = "idle";
      this.send({ kind: "patch", patch: { thread: { kind: "changed", id: open.id, delta: { appended: [done], streamingTail: null, status: "idle" } } } });
    });
  }
}

const vite = await createViteServer({
  configFile: path.join(ROOT, "vite.mobile.config.mts"),
  root: ROOT,
  server: { middlewareMode: true },
  appType: "custom",
});

const template = await readFile(path.join(ROOT, "index.mobile.html"), "utf8");

const server = createServer((request, response) => {
  const url = request.url ?? "/";
  if (url === "/") {
    response.writeHead(302, { location: `${MOBILE_APP_PATH}/` });
    response.end();
    return;
  }
  /**
   * The page lives under {@link MOBILE_APP_PATH} the way the real server serves it, but the modules
   * it asks for are absolute and so arrive without that prefix. Both reach the dev server; only a
   * prefixed path is allowed to fall through to the page itself.
   */
  const prefixed = url.startsWith(MOBILE_APP_PATH);
  const rest = prefixed ? url.slice(MOBILE_APP_PATH.length) || "/" : url;
  request.url = rest;
  vite.middlewares(request, response, () => {
    if (!prefixed) {
      response.writeHead(404).end("Not found");
      return;
    }
    /** Every path the phone routes to is the same page, the way the real server serves it. */
    void vite.transformIndexHtml(rest, template.replace(CSP_META, "")).then((html) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(html);
    }).catch((error: unknown) => {
      response.writeHead(500).end(error instanceof Error ? error.message : String(error));
    });
  });
});

const sockets = new WebSocketServer({ noServer: true });
server.on("upgrade", (request, socket, head) => {
  if (!(request.url ?? "").startsWith(SOCKET_PATH)) {
    socket.destroy();
    return;
  }
  sockets.handleUpgrade(request, socket, head, (connection) => new Stand(connection));
});

server.listen(PORT, "127.0.0.1", () => {
  const link = `http://127.0.0.1:${PORT}${MOBILE_APP_PATH}/#pair=${CODE}`;
  console.log(`\n  Phone page:   ${link}`);
  console.log(`  Already on:   http://127.0.0.1:${PORT}${MOBILE_APP_PATH}/`);
  console.log(`\n  Nothing real is behind this. Ctrl-C to stop.\n`);
});
