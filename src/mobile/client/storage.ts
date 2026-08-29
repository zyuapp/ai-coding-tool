import { PAIRING_CODE_LENGTH } from "../../domain/mobile";
import type { MobileCredential } from "./protocol";

/** Where the device token lives between visits. Clearing site data unpairs the phone, as it should. */
export const MOBILE_CREDENTIAL_KEY = "aicodingtool.mobile.device";

/** Only what the reducer needs; a full Storage is more than a test should have to build. */
export type CredentialStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function readCredential(store: CredentialStore): MobileCredential | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(store.getItem(MOBILE_CREDENTIAL_KEY) ?? "null");
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const { token, deviceId, deviceName } = parsed as Record<string, unknown>;
  if (typeof token !== "string" || typeof deviceId !== "string" || typeof deviceName !== "string") return null;
  if (!token || !deviceId) return null;
  return { token, deviceId, deviceName };
}

export function writeCredential(store: CredentialStore, credential: MobileCredential | null): void {
  if (credential) store.setItem(MOBILE_CREDENTIAL_KEY, JSON.stringify(credential));
  else store.removeItem(MOBILE_CREDENTIAL_KEY);
}

const CODE = /^[0-9A-HJKMNP-TV-Z]+$/;

/**
 * The pairing code out of the address the QR opened. The QR writes it to the fragment, which is
 * never sent to a server and so never reaches a log; a query string is read too, so a code typed
 * or shared by hand still pairs.
 */
export function readPairingCode(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const fragment = new URLSearchParams(parsed.hash.replace(/^#/, ""));
  const code = (fragment.get("pair") ?? parsed.searchParams.get("pair") ?? "").trim().toUpperCase();
  if (code.length !== PAIRING_CODE_LENGTH || !CODE.test(code)) return null;
  return code;
}

/** The same address with the code taken out, so a reload or a screenshot cannot leak a spent one. */
export function withoutPairingCode(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.delete("pair");
  const fragment = new URLSearchParams(parsed.hash.replace(/^#/, ""));
  fragment.delete("pair");
  const rest = fragment.toString();
  parsed.hash = rest ? `#${rest}` : "";
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

/** The socket the phone talks on, alongside the page the same server handed it. */
export function socketUrl(url: string): string {
  const parsed = new URL(url);
  parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  parsed.pathname = `${parsed.pathname.replace(/\/$/, "")}/socket`;
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

/** What the phone calls itself in the Mac's list of paired devices. */
export function deviceName(agent: string): string {
  if (/\biPad\b/.test(agent)) return "iPad";
  if (/\biPhone\b/.test(agent)) return "iPhone";
  if (/\bAndroid\b/.test(agent)) return "Android phone";
  if (/\bMacintosh\b/.test(agent)) return "Mac";
  return "Phone";
}

/** Which list groups the phone has folded shut, by project id or "recents". */
export const MOBILE_FOLDED_KEY = "aicodingtool.mobile.folded";

export function readFolded(store: CredentialStore): Set<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(store.getItem(MOBILE_FOLDED_KEY) ?? "[]");
  } catch {
    return new Set();
  }
  if (!Array.isArray(parsed)) return new Set();
  return new Set(parsed.filter((key): key is string => typeof key === "string"));
}

export function writeFolded(store: CredentialStore, folded: Set<string>): void {
  store.setItem(MOBILE_FOLDED_KEY, JSON.stringify([...folded]));
}
