import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { MobileErrorCode } from "../../contracts/mobile.js";
import {
  createPairingCode,
  deviceView,
  MAX_PAIRED_DEVICES,
  noPairingAttempts,
  pairingCodeLive,
  pairingCodeMatches,
  pairingAttemptsStale,
  pairingLocked,
  registerPairingFailure,
  type PairedDevice,
  type PairedDeviceView,
  type PairingAttempts,
  type PairingCode,
} from "../../domain/mobile.js";

/** What a phone is called when it does not say. */
const UNNAMED_DEVICE = "Phone";
const MAX_DEVICE_NAME = 128;
/** How far `lastSeenAt` may drift before it is worth a write. It is shown in days, so a minute is nothing. */
const SEEN_WRITE_INTERVAL_MS = 60 * 1_000;

export type PairingOutcome =
  | { ok: true; device: PairedDevice; token: string }
  | { ok: false; code: MobileErrorCode; message: string };

type StoredDevices = { version: 1; devices: PairedDevice[] };

function hashToken(token: string) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Hashes are the same length, so the comparison is a straight constant-time walk over their bytes. */
function hashesMatch(left: string, right: string) {
  if (left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function readableName(name: unknown) {
  const trimmed = typeof name === "string" ? name.trim().slice(0, MAX_DEVICE_NAME) : "";
  return trimmed || UNNAMED_DEVICE;
}

function isStoredDevice(value: unknown): value is PairedDevice {
  if (!value || typeof value !== "object") return false;
  const device = value as Record<string, unknown>;
  return typeof device.id === "string" && device.id.length > 0
    && typeof device.name === "string"
    && typeof device.tokenHash === "string" && /^[0-9a-f]{64}$/.test(device.tokenHash)
    && typeof device.pairedAt === "number"
    && (device.lastSeenAt === null || typeof device.lastSeenAt === "number");
}

/**
 * Who has been let in, and who is being kept out. The pairing code lives here rather than in the
 * server because spending one and writing the device it bought are the same moment.
 *
 * Only the hash of a device token is ever written, so this file cannot be read back into a working
 * credential. Failed codes are counted per source address, and the count shuts the door for a while
 * before it is worth guessing further.
 */
export class PairingStore {
  private readonly filePath: string;
  private devices: PairedDevice[];
  private code: PairingCode | null = null;
  private readonly attempts = new Map<string, PairingAttempts>();

  constructor(filePath: string) {
    this.filePath = filePath;
    this.devices = this.read();
  }

  /** An unreadable or half-written file means no paired device rather than a launch that fails. */
  private read(): PairedDevice[] {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, "utf8"));
      const stored = parsed as StoredDevices | null;
      if (!stored || !Array.isArray(stored.devices)) return [];
      return stored.devices.filter(isStoredDevice).slice(0, MAX_PAIRED_DEVICES);
    } catch {
      return [];
    }
  }

  /** Written beside and renamed over, so a crash mid-write leaves the last good list rather than half of one. */
  private write() {
    const stored: StoredDevices = { version: 1, devices: this.devices };
    try {
      mkdirSync(path.dirname(this.filePath), { recursive: true });
      const staging = `${this.filePath}.tmp`;
      writeFileSync(staging, JSON.stringify(stored), { mode: 0o600 });
      renameSync(staging, this.filePath);
    } catch (error) {
      console.error("Could not write the paired phone list:", error);
    }
  }

  list(): PairedDevice[] {
    return [...this.devices];
  }

  views(): PairedDeviceView[] {
    return this.devices.map(deviceView);
  }

  /** Mints the code the QR carries. A second mint discards the first, so only one code ever stands. */
  mint(at: number): PairingCode {
    this.code = createPairingCode(at);
    return this.code;
  }

  /** The code on screen, or null once it has expired or been spent. */
  pending(at: number): PairingCode | null {
    if (!pairingCodeLive(this.code, at)) this.code = null;
    return this.code;
  }

  discardCode() {
    this.code = null;
  }

  /**
   * Trades a code for a token of the phone's own. A wrong guess leaves the code standing, because
   * spending it would let anything that can reach the port cancel the user's pairing by guessing
   * once; the caller's failure count is what makes guessing not worth it.
   */
  redeem(code: string, deviceName: string, source: string, at: number): PairingOutcome {
    const held = this.attempts.get(source);
    const attempts = held && !pairingAttemptsStale(held, at) ? held : noPairingAttempts();
    if (pairingLocked(attempts, at)) {
      return { ok: false, code: "rate-limited", message: "Too many wrong codes. Wait a few minutes and scan the code again." };
    }
    const pending = this.pending(at);
    /** With no code standing there is nothing to guess at, so a late scan is not counted as a guess. */
    if (!pending) return { ok: false, code: "expired-code", message: "That pairing code has expired. Show a new one on the computer." };
    if (!pairingCodeMatches(pending, code)) {
      this.attempts.set(source, registerPairingFailure(attempts, at));
      this.prune(at);
      return { ok: false, code: "expired-code", message: "That pairing code is wrong or has expired. Show a new one on the computer." };
    }
    this.code = null;
    this.attempts.delete(source);
    if (this.devices.length >= MAX_PAIRED_DEVICES) {
      return { ok: false, code: "unauthorized", message: `This computer is already paired with ${MAX_PAIRED_DEVICES} phones. Revoke one first.` };
    }
    const token = randomBytes(32).toString("hex");
    const device: PairedDevice = {
      id: randomUUID(),
      name: readableName(deviceName),
      tokenHash: hashToken(token),
      pairedAt: at,
      lastSeenAt: at,
    };
    this.devices = [...this.devices, device];
    this.write();
    return { ok: true, device, token };
  }

  /** Whether this caller has spent its guesses at the pairing code. */
  locked(source: string, at: number): boolean {
    const attempts = this.attempts.get(source);
    return attempts !== undefined && pairingLocked(attempts, at);
  }

  /** A record older than the lockout it could have earned says nothing, so it is not kept. */
  private prune(at: number) {
    for (const [source, attempts] of this.attempts) {
      if (pairingAttemptsStale(attempts, at)) this.attempts.delete(source);
    }
  }

  /** The device a token belongs to, or null when no stored hash matches it. */
  authenticate(token: string): PairedDevice | null {
    const hash = hashToken(token);
    return this.devices.find((device) => hashesMatch(device.tokenHash, hash)) ?? null;
  }

  markSeen(deviceId: string, at: number) {
    const device = this.devices.find((entry) => entry.id === deviceId);
    if (!device || (device.lastSeenAt !== null && at - device.lastSeenAt < SEEN_WRITE_INTERVAL_MS)) return;
    this.devices = this.devices.map((entry) => entry.id === deviceId ? { ...entry, lastSeenAt: at } : entry);
    this.write();
  }

  revoke(deviceId: string): boolean {
    const kept = this.devices.filter((device) => device.id !== deviceId);
    if (kept.length === this.devices.length) return false;
    this.devices = kept;
    this.write();
    return true;
  }
}
