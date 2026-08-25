/**
 * The phone bridge's vocabulary: how a phone is let in, where it reaches the Mac, and what the
 * desktop settings screen says about all of it. Nothing here talks to a socket or reads the network;
 * the main process does that and describes what it found in these terms.
 */

/** How long a pairing code stands before it is worthless. Short, because the QR is on screen. */
export const PAIRING_CODE_TTL_MS = 2 * 60 * 1_000;

/** Characters a pairing code is drawn from: Crockford base32, so 0/O and 1/I cannot be mistyped. */
const PAIRING_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export const PAIRING_CODE_LENGTH = 8;

/** Bad codes in a row before the door shuts, and how long it stays shut. */
export const MAX_PAIRING_FAILURES = 5;
export const PAIRING_LOCKOUT_MS = 5 * 60 * 1_000;

/** How many device tokens the Mac will hold. Past this, pairing a new phone is refused until one is revoked. */
export const MAX_PAIRED_DEVICES = 16;

/**
 * How much of a session's outbound traffic is kept so a phone that drops resumes rather than reloads.
 * A streaming reply commits many times a second, so the count alone would cover only seconds; the
 * byte budget is what stops a long transcript's worth of patches from being kept per session.
 */
export const MOBILE_EVENT_BUFFER = 600;
export const MOBILE_BUFFER_BYTES = 1024 * 1024;

/** How many sessions one phone may hold at once. Past this the oldest is hung up on. */
export const MAX_SESSIONS_PER_DEVICE = 4;

/** How many sockets that have not yet said who they are the server will hold at once. */
export const MAX_PENDING_SOCKETS = 32;

/** How often the server pings a live session, and how long silence runs before the line is called dead. */
export const MOBILE_PING_INTERVAL_MS = 15 * 1_000;
export const MOBILE_DEAD_AFTER_MS = 45 * 1_000;

/** The port the local server asks for first. Taken, it falls back to whatever the machine offers. */
export const MOBILE_DEFAULT_PORT = 7737;

/** The path the phone app is served from, which is also what a pairing URL points at. */
export const MOBILE_APP_PATH = "/m";

/**
 * Where a phone can reach the Mac. Loopback is the default bind and only works on the Mac itself;
 * `lan` is the opt-in bind that anything on the same network can see; `tailscale-https` is the name
 * Tailscale Serve answers on, which is the only one with a real certificate in front of it.
 */
export type MobileAddressKind = "loopback" | "lan" | "tailscale-https";

export type MobileAddress = {
  kind: MobileAddressKind;
  host: string;
  port: number;
};

/** Only Tailscale Serve terminates TLS; the local server itself never speaks HTTPS. */
export function addressSecure(address: MobileAddress): boolean {
  return address.kind === "tailscale-https";
}

/** The scheme, host and port a phone types, with the default port left off the way a browser does. */
export function addressOrigin(address: MobileAddress): string {
  const secure = addressSecure(address);
  const scheme = secure ? "https" : "http";
  const bare = (secure && address.port === 443) || (!secure && address.port === 80);
  return bare ? `${scheme}://${address.host}` : `${scheme}://${address.host}:${address.port}`;
}

/** Which address the QR should carry: the one with a certificate, then the one off-machine phones can see. */
export function preferredAddress(addresses: MobileAddress[]): MobileAddress | null {
  const rank: MobileAddressKind[] = ["tailscale-https", "lan", "loopback"];
  for (const kind of rank) {
    const match = addresses.find((address) => address.kind === kind);
    if (match) return match;
  }
  return null;
}

/** Whether the server is running, and why it is not when it is not. */
export type MobileServerStatus = "off" | "starting" | "listening" | "error";

/** What a phone's own connection is doing, as the phone app draws it. */
export type MobileConnectionState = "offline" | "connecting" | "resuming" | "live";

/**
 * A one-time code shown as a QR. It expires on its own and is spent by the first phone that trades
 * it for a token, so a photograph of a stale screen is worth nothing.
 */
export type PairingCode = {
  code: string;
  createdAt: number;
  expiresAt: number;
};

/** The code together with the address it is good for, which is exactly what the QR encodes. */
export type MobilePairingOffer = {
  code: string;
  expiresAt: number;
  address: MobileAddress;
  /** The URL drawn as the QR. The phone opens it and pairs without typing anything. */
  url: string;
};

/**
 * A phone that has paired. Only the hash of its token is kept, so the file this is stored in cannot
 * be read back into a working credential.
 */
export type PairedDevice = {
  id: string;
  /** What the phone called itself when it paired. Shown in settings so the user can tell them apart. */
  name: string;
  /** Hex SHA-256 of the device token. The token itself is shown once, to the phone, and never stored. */
  tokenHash: string;
  pairedAt: number;
  lastSeenAt: number | null;
};

/** A paired device as settings draws it. The hash never leaves the main process. */
export type PairedDeviceView = Omit<PairedDevice, "tokenHash">;

export function deviceView(device: PairedDevice): PairedDeviceView {
  const { tokenHash: _secret, ...view } = device;
  return view;
}

/** One phone's live connection. It outlives a dropped socket long enough for that phone to resume. */
export type MobileSession = {
  id: string;
  deviceId: string;
  startedAt: number;
  lastSeenAt: number;
  /** The highest sequence this session has sent, which is what a resume is measured against. */
  sequence: number;
  connection: MobileConnectionState;
};

export type MobileSessionView = Omit<MobileSession, "deviceId"> & { deviceName: string };

/** Whether Tailscale is on this machine, signed in, and serving HTTPS in front of the local server. */
export type TailscaleState = {
  status: "unknown" | "missing" | "logged-out" | "ready";
  /** The MagicDNS name of this machine, once Tailscale will say what it is. */
  magicDnsName: string | null;
  /** Whether `tailscale serve` is currently pointed at the local server. */
  serving: boolean;
  error: string | null;
};

export function emptyTailscaleState(): TailscaleState {
  return { status: "unknown", magicDnsName: null, serving: false, error: null };
}

/** Everything the desktop settings section draws, and everything a phone bridge decision reads. */
export type MobileServerState = {
  enabled: boolean;
  status: MobileServerStatus;
  /** Whether the server also binds a LAN address, which is off by default and plainly less safe. */
  lanExposed: boolean;
  port: number | null;
  addresses: MobileAddress[];
  /** The address the QR points at, chosen by {@link preferredAddress}. */
  primary: MobileAddress | null;
  devices: PairedDeviceView[];
  sessions: MobileSessionView[];
  tailscale: TailscaleState;
  /** The code on screen right now, if one has been minted and has yet to expire or be spent. */
  pairing: MobilePairingOffer | null;
  error: string | null;
};

export function emptyMobileServerState(): MobileServerState {
  return {
    enabled: false,
    status: "off",
    lanExposed: false,
    port: null,
    addresses: [],
    primary: null,
    devices: [],
    sessions: [],
    tailscale: emptyTailscaleState(),
    pairing: null,
    error: null,
  };
}

/** Failed pairing attempts from one source, and the lockout the last of them earned. */
export type PairingAttempts = {
  failures: number;
  lockedUntil: number | null;
  /** When the last of them was, which is what says a record has stopped being worth keeping. */
  lastFailureAt: number;
};

export function noPairingAttempts(): PairingAttempts {
  return { failures: 0, lockedUntil: null, lastFailureAt: 0 };
}

export function pairingLocked(attempts: PairingAttempts, at: number): boolean {
  return attempts.lockedUntil !== null && at < attempts.lockedUntil;
}

/** One more wrong code. Reaching the limit shuts the door and starts the count again behind it. */
export function registerPairingFailure(attempts: PairingAttempts, at: number): PairingAttempts {
  const failures = attempts.failures + 1;
  if (failures < MAX_PAIRING_FAILURES) return { failures, lockedUntil: attempts.lockedUntil, lastFailureAt: at };
  return { failures: 0, lockedUntil: at + PAIRING_LOCKOUT_MS, lastFailureAt: at };
}

/** Whether a record still says anything: a stale part-count is worth no more than no record at all. */
export function pairingAttemptsStale(attempts: PairingAttempts, at: number): boolean {
  return !pairingLocked(attempts, at) && at - attempts.lastFailureAt >= PAIRING_LOCKOUT_MS;
}

/** A code that is spent or accepted clears the count, so an honest phone never inherits a lockout. */
export function clearPairingFailures(): PairingAttempts {
  return noPairingAttempts();
}

function randomBytes(count: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(count));
}

/** Random characters from the unmistakable alphabet. The modulo bias over 32 of 256 values is none. */
export function generatePairingCode(length = PAIRING_CODE_LENGTH): string {
  const bytes = randomBytes(length);
  let code = "";
  for (const byte of bytes) code += PAIRING_ALPHABET[byte % PAIRING_ALPHABET.length];
  return code;
}

export function createPairingCode(at: number, ttlMs = PAIRING_CODE_TTL_MS): PairingCode {
  return { code: generatePairingCode(), createdAt: at, expiresAt: at + ttlMs };
}

/** Whether a code is still worth trading. Spending it is the caller's business; this only reads the clock. */
export function pairingCodeLive(pairing: PairingCode | null, at: number): boolean {
  return pairing !== null && at < pairing.expiresAt;
}

/** Codes are compared with a constant-time walk, so a guess learns nothing from how long it took. */
export function pairingCodeMatches(pairing: PairingCode, code: string): boolean {
  return constantTimeEquals(pairing.code, code.trim().toUpperCase());
}

export function constantTimeEquals(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

/** 256 bits of hex. The phone keeps it; the Mac keeps only {@link hashDeviceToken} of it. */
export function generateDeviceToken(): string {
  return toHex(randomBytes(32));
}

export async function hashDeviceToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return toHex(new Uint8Array(digest));
}

/** The device a token belongs to, or null when no stored hash matches it. */
export async function deviceForToken(devices: PairedDevice[], token: string): Promise<PairedDevice | null> {
  const hash = await hashDeviceToken(token);
  return devices.find((device) => constantTimeEquals(device.tokenHash, hash)) ?? null;
}

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/**
 * What the QR encodes: where to reach the Mac, and the code to trade once the page loads. The code
 * rides the fragment, which no proxy in front of the server ever sees, and the path ends in a slash
 * so the page is not redirected before reading it.
 */
export function pairingUrl(address: MobileAddress, code: string): string {
  return `${addressOrigin(address)}${MOBILE_APP_PATH}/#pair=${encodeURIComponent(code)}`;
}

export function pairingOffer(address: MobileAddress, pairing: PairingCode): MobilePairingOffer {
  return { code: pairing.code, expiresAt: pairing.expiresAt, address, url: pairingUrl(address, pairing.code) };
}

/** The other half of {@link pairingUrl}. Null for anything that is not one of ours. */
export function parsePairingUrl(url: string): { origin: string; code: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.pathname.replace(/\/$/, "") !== MOBILE_APP_PATH) return null;
  const fragment = new URLSearchParams(parsed.hash.replace(/^#/, ""));
  const code = fragment.get("pair") ?? parsed.searchParams.get("pair");
  if (!code || code.length > PAIRING_CODE_LENGTH * 4) return null;
  return { origin: parsed.origin, code: code.toUpperCase() };
}
