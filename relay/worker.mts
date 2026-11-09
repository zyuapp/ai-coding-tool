/**
 * The push relay: holds the APNs key so no app has to, and forwards a computer's notice to a paired
 * phone. It stores nothing; a computer names the phone by the device token the phone gave it.
 */

export type RelayEnv = {
  /** The APNs auth key as Apple issued it, a PKCS #8 PEM. */
  APNS_KEY: string;
  APNS_KEY_ID: string;
  APPLE_TEAM_ID: string;
  APNS_TOPIC: string;
  PER_DEVICE?: RateLimiter;
};

type RateLimiter = { limit(options: { key: string }): Promise<{ success: boolean }> };

export type PushEnvironment = "production" | "sandbox";

/** One notice for one phone. `thread` groups a thread's notices and replaces the one before it. */
export type PushRequest = {
  token: string;
  environment: PushEnvironment;
  title: string;
  body: string;
  thread: string;
  /** What a tap opens, read by the app and nowhere else. */
  data: Record<string, string>;
};

/** `gone` means the phone no longer takes pushes at that token, so the computer forgets it. */
export type PushResult = { ok: true } | { ok: false; gone: boolean; reason: string };

export const LIMITS = { title: 120, body: 300, thread: 128, dataEntries: 8, dataValue: 256 } as const;

const TOKEN = /^[0-9a-f]{64,200}$/;
const APNS_HOST: Record<PushEnvironment, string> = {
  production: "https://api.push.apple.com",
  sandbox: "https://api.sandbox.push.apple.com",
};
/** Apple refuses a provider token older than an hour and throttles one renewed more often than every twenty minutes. */
const JWT_LIFETIME_MS = 50 * 60 * 1_000;
/** A notice older than this is stale news, so APNs drops it rather than delivering it late. */
const EXPIRY_SECONDS = 6 * 60 * 60;
const GONE_REASONS = new Set(["BadDeviceToken", "Unregistered", "DeviceTokenNotForTopic"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown, max: number, allowEmpty = false): value is string {
  return typeof value === "string" && value.length <= max && (allowEmpty || value.length > 0);
}

export function isPushRequest(value: unknown): value is PushRequest {
  if (!isRecord(value) || !isRecord(value.data)) return false;
  const entries = Object.entries(value.data);
  return typeof value.token === "string" && TOKEN.test(value.token)
    && (value.environment === "production" || value.environment === "sandbox")
    && isText(value.title, LIMITS.title)
    && isText(value.body, LIMITS.body, true)
    && isText(value.thread, LIMITS.thread)
    && entries.length <= LIMITS.dataEntries
    && entries.every(([key, entry]) => key !== "aps" && isText(key, 32) && isText(entry, LIMITS.dataValue));
}

/** The APNs body for a notice: a banner with sound, grouped by thread, plus what a tap opens. */
export function apnsPayload(request: PushRequest) {
  return {
    aps: {
      alert: { title: request.title, ...(request.body ? { body: request.body } : {}) },
      sound: "default",
      "thread-id": request.thread,
    },
    ...request.data,
  };
}

function base64Url(bytes: ArrayBuffer | Uint8Array | string) {
  const raw = typeof bytes === "string" ? new TextEncoder().encode(bytes) : new Uint8Array(bytes);
  let binary = "";
  for (const byte of raw) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemBody(pem: string) {
  const body = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Signs the ES256 provider token APNs authenticates the relay by. */
export async function providerToken(env: Pick<RelayEnv, "APNS_KEY" | "APNS_KEY_ID" | "APPLE_TEAM_ID">, now: number) {
  const key = await crypto.subtle.importKey("pkcs8", pemBody(env.APNS_KEY), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const header = base64Url(JSON.stringify({ alg: "ES256", kid: env.APNS_KEY_ID }));
  const claims = base64Url(JSON.stringify({ iss: env.APPLE_TEAM_ID, iat: Math.floor(now / 1_000) }));
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(`${header}.${claims}`));
  return `${header}.${claims}.${base64Url(signature)}`;
}

let cached: { token: string; issuedAt: number; keyId: string } | null = null;

async function currentToken(env: RelayEnv, now: number) {
  if (cached && cached.keyId === env.APNS_KEY_ID && now - cached.issuedAt < JWT_LIFETIME_MS) return cached.token;
  cached = { token: await providerToken(env, now), issuedAt: now, keyId: env.APNS_KEY_ID };
  return cached.token;
}

export async function sendToApns(env: RelayEnv, request: PushRequest, now = Date.now(), send: typeof fetch = fetch): Promise<PushResult> {
  const response = await send(`${APNS_HOST[request.environment]}/3/device/${request.token}`, {
    method: "POST",
    headers: {
      authorization: `bearer ${await currentToken(env, now)}`,
      "apns-topic": env.APNS_TOPIC,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "apns-expiration": String(Math.floor(now / 1_000) + EXPIRY_SECONDS),
      "apns-collapse-id": request.thread.slice(0, 64),
      "content-type": "application/json",
    },
    body: JSON.stringify(apnsPayload(request)),
  });
  if (response.ok) return { ok: true };
  const reason = await response.json().then((body) => (isRecord(body) && typeof body.reason === "string" ? body.reason : ""), () => "");
  if (reason === "ExpiredProviderToken" || reason === "InvalidProviderToken") cached = null;
  return { ok: false, gone: response.status === 410 || GONE_REASONS.has(reason), reason: reason || `HTTP ${response.status}` };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export async function handle(request: Request, env: RelayEnv, send: typeof fetch = fetch): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health") return json({ ok: true });
  if (request.method !== "POST" || url.pathname !== "/v1/push") return json({ ok: false, reason: "Not found" }, 404);
  const body: unknown = await request.json().catch(() => null);
  if (!isPushRequest(body)) return json({ ok: false, gone: false, reason: "Unreadable request" }, 400);
  if (env.PER_DEVICE && !(await env.PER_DEVICE.limit({ key: body.token })).success) {
    return json({ ok: false, gone: false, reason: "Too many notices for this phone" }, 429);
  }
  const result = await sendToApns(env, body, Date.now(), send);
  return json(result, result.ok ? 200 : result.gone ? 410 : 502);
}

export default { fetch: (request: Request, env: RelayEnv) => handle(request, env) };
