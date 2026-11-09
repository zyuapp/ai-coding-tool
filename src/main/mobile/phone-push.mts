import type { ThreadNotice } from "../../contracts/ipc.js";
import type { PairedDevice, PhonePush } from "../../domain/mobile.js";

/** The relay that holds the APNs key; the app only ever names a phone by the token it was given. */
export const PUSH_RELAY_URL = "https://aicodingtool-relay.zyuapp.workers.dev/v1/push";

const TITLE_MAX = 120;
const BODY_MAX = 300;
const SEND_TIMEOUT_MS = 10_000;

export type PushTargets = {
  pushTargets(): Array<PairedDevice & { push: PhonePush }>;
  setPush(deviceId: string, push: PhonePush | null): void;
};

function clip(text: string, max: number) {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}

/**
 * The relay's request for one phone. A thread's notices share a group, and each replaces the one
 * before, so a phone shows where a thread stands rather than everything it went through.
 */
export function pushRequest(device: PairedDevice & { push: PhonePush }, notice: ThreadNotice) {
  return {
    token: device.push.token,
    environment: device.push.environment,
    title: clip(notice.title, TITLE_MAX) || "AI Coding Tool",
    body: clip(notice.headline, BODY_MAX),
    thread: `${device.id}:${notice.taskId}`.slice(0, 128),
    data: { taskId: notice.taskId, deviceId: device.id },
  };
}

/**
 * Hands a notice to every phone that takes them. A phone Apple says is gone stops being asked; any
 * other failure is the relay's or the network's, and the notice is simply not delivered.
 */
export async function pushToPhones(targets: PushTargets, notice: ThreadNotice, send: typeof fetch = fetch) {
  await Promise.all(targets.pushTargets().map(async (device) => {
    try {
      const response = await send(PUSH_RELAY_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(pushRequest(device, notice)),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      if (response.status === 410) targets.setPush(device.id, null);
      else if (!response.ok) console.error(`The push relay refused a notice (HTTP ${response.status}).`);
    } catch (error) {
      console.error("Could not reach the push relay:", error instanceof Error ? error.message : error);
    }
  }));
}
