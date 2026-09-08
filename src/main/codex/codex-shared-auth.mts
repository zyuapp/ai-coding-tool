import type { AppServerClient, AppServerCommand } from "./app-server-client.mjs";
import type { GetAuthStatusResponse } from "./protocol/GetAuthStatusResponse.js";
import type { LoginAccountParams } from "./protocol/v2/LoginAccountParams.js";

type AuthClient = Pick<AppServerClient, "initialize" | "request" | "close">;
type Connection = { client: Promise<AuthClient>; users: number; refreshing?: Promise<LoginAccountParams | null> };
const connections = new Map<string, Connection>();

/** Keychain access stays in Codex, under the original home. The conversation receives only an
 * in-memory access token. Never copy refresh tokens, reimplement OS credential stores, or log tokens. */
export function sharedAuthLogin(status: GetAuthStatusResponse): LoginAccountParams | null {
  if (!status.authMethod) return null;
  if (!status.authToken) throw new Error(`Codex cannot share ${status.authMethod} authentication with a private conversation home.`);
  if (status.authMethod === "apikey") return { type: "apiKey", apiKey: status.authToken };
  if (status.authMethod === "chatgpt" || status.authMethod === "chatgptAuthTokens") {
    let claims: { [key: string]: unknown };
    try { claims = JSON.parse(Buffer.from(status.authToken.split(".")[1] ?? "", "base64url").toString("utf8")); }
    catch { throw new Error("Codex returned an unreadable ChatGPT access token."); }
    const auth = claims["https://api.openai.com/auth"] as { chatgpt_account_id?: unknown; chatgpt_plan_type?: unknown } | undefined;
    if (typeof auth?.chatgpt_account_id !== "string" || !auth.chatgpt_account_id) throw new Error("Codex's ChatGPT access token has no account identifier.");
    return { type: "chatgptAuthTokens", accessToken: status.authToken, chatgptAccountId: auth.chatgpt_account_id, chatgptPlanType: typeof auth.chatgpt_plan_type === "string" ? auth.chatgpt_plan_type : null };
  }
  throw new Error(`Codex cannot share ${status.authMethod} authentication with a private conversation home.`);
}

/** One credential connection per source, shared by all concurrent conversations. */
export async function acquireSharedAuth(command: AppServerCommand, connect: (command: AppServerCommand) => AuthClient) {
  const key = JSON.stringify([command.executable, command.env?.CODEX_HOME, command.args]);
  let connection = connections.get(key);
  if (!connection) {
    const client = connect(command);
    const ready = client.initialize({ name: "aicodingtool_auth", title: "AICodingTool authentication", version: "1" }).then(() => client).catch(async (error: unknown) => { await client.close(); throw error; });
    connection = { client: ready, users: 0 };
    connections.set(key, connection);
  }
  const entry = connection;
  entry.users++;
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    if (--entry.users === 0) {
      if (connections.get(key) === entry) connections.delete(key);
      await entry.client.then((client) => client.close()).catch(() => {});
    }
  };
  try { await entry.client; } catch (error) { await release(); throw error; }
  const read = async (refresh = false) => {
    if (entry.refreshing) return entry.refreshing;
    const result = entry.client.then(async (client) => sharedAuthLogin(await client.request("getAuthStatus", { includeToken: true, refreshToken: refresh }) as GetAuthStatusResponse));
    if (refresh) {
      entry.refreshing = result;
      void result.finally(() => { if (entry.refreshing === result) entry.refreshing = undefined; }).catch(() => {});
    }
    return result;
  };
  return { read, release };
}
