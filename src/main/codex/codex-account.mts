import type { AgentEngine, EngineAccess, EngineStatus } from "../../domain/agent-engine.js";
import { AppServerClient, codexAppServer, type AppServerCommand, type NotificationParams } from "./app-server-client.mjs";
import type { ClientInfo } from "./protocol/ClientInfo.js";

/** What the account check asks of its connection. The real client fits; a scripted one can stand in for it. */
export type AccountClient = Pick<AppServerClient, "initialize" | "request" | "on" | "close" | "exited">;
export type AccountConnect = (command: AppServerCommand) => AccountClient;

const CLIENT_INFO: ClientInfo = { name: "aicodingtool", title: "AICodingTool", version: "1" };

/** How long the browser has to bring the sign-in back before it is given up on. */
const SIGN_IN_TIMEOUT_MS = 5 * 60_000;

const defaultConnect: AccountConnect = (command) => new AppServerClient(command);

async function accountAccess(client: AccountClient): Promise<EngineAccess> {
  const account = await client.request("account/read", { refreshToken: false });
  return account.account ? "ready" : "signed-out";
}

/**
 * Whether Codex can take a run, asked of a short-lived app server: a binary that will not start is
 * unavailable, one that starts with no account is signed out.
 */
async function readCodexAccess(connect: AccountConnect): Promise<EngineAccess> {
  let client: AccountClient;
  try {
    client = connect(codexAppServer());
  } catch {
    return "unavailable";
  }
  try {
    await client.initialize(CLIENT_INFO);
    return await accountAccess(client);
  } catch {
    return "unavailable";
  } finally {
    void client.close();
  }
}

/**
 * The browser sign-in Codex runs itself: it hands back a URL to open and says when the browser has
 * come back to it. The server has to outlive the round trip, since it is what the browser returns to.
 */
async function signInToCodex(connect: AccountConnect, openUrl: (url: string) => Promise<void>): Promise<EngineAccess> {
  const client = connect(codexAppServer());
  let timer: NodeJS.Timeout | undefined;
  try {
    const completed = new Promise<NotificationParams<"account/login/completed">>((resolve) => client.on("account/login/completed", resolve));
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Codex sign-in timed out. Try again.")), SIGN_IN_TIMEOUT_MS);
      timer.unref();
    });
    const stopped = client.exited.then(() => { throw new Error("Codex stopped before the sign-in finished."); });
    await client.initialize(CLIENT_INFO);
    const started = await client.request("account/login/start", { type: "chatgpt" });
    if (started.type !== "chatgpt") throw new Error("Codex offered no browser sign-in.");
    await openUrl(started.authUrl);
    const outcome = await Promise.race([completed, expired, stopped]);
    if (!outcome.success) throw new Error(outcome.error ?? "Codex sign-in failed.");
    return await accountAccess(client);
  } finally {
    clearTimeout(timer);
    void client.close();
  }
}

/** Which engines can take a run. Codex is asked once per process; a sign-in asks it again. */
export class EngineAccessHost {
  private readonly connect: AccountConnect;
  private status: Promise<EngineStatus> | undefined;
  private signingIn: Promise<EngineStatus> | undefined;

  constructor(connect: AccountConnect = defaultConnect) {
    this.connect = connect;
  }

  read(): Promise<EngineStatus> {
    this.status ??= readCodexAccess(this.connect).then((codex) => ({ codex }));
    return this.status;
  }

  /** One sign-in at a time: a second ask while the browser is out joins the first. */
  signIn(engine: AgentEngine, openUrl: (url: string) => Promise<void>): Promise<EngineStatus> {
    if (engine !== "codex") return this.read();
    this.signingIn ??= signInToCodex(this.connect, openUrl)
      .then((codex) => {
        const status: EngineStatus = { codex };
        this.status = Promise.resolve(status);
        return status;
      })
      .finally(() => { this.signingIn = undefined; });
    return this.signingIn;
  }
}
