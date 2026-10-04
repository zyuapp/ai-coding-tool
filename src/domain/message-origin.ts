/**
 * Who put a user message in a thread when the user did not type it. A user message without one is the
 * user's own words. `detail` still carries the label for display, which older builds read instead.
 */
export type MessageOrigin =
  /** Another thread. The title is the one it had when it sent the message. */
  | { kind: "thread"; threadId?: string; title: string }
  | { kind: "automation"; runNumber: number }
  /** A coordinator's batch of news from its threads. */
  | { kind: "coordination" }
  /** Written by a build that kept only a label, which is all that says where it came from. */
  | { kind: "legacy"; label: string };

const FROM = "From ";
const SEPARATOR = " · ";
const COORDINATION = "Thread updates";
const AUTOMATION = /^Automation run #(\d+)$/;

/** What a message's origin reads as. */
export function originLabel(origin: MessageOrigin): string {
  switch (origin.kind) {
    case "thread": return `${FROM}${origin.title}${origin.threadId ? `${SEPARATOR}${origin.threadId}` : ""}`;
    case "automation": return `Automation run #${origin.runNumber}`;
    case "coordination": return COORDINATION;
    case "legacy": return origin.label;
  }
}

/** The short name a folded row gives the sender. */
export function senderLabel(origin: MessageOrigin | undefined): string | undefined {
  if (origin?.kind === "thread") return `${FROM}${origin.title}`;
  if (origin?.kind === "coordination") return COORDINATION;
  return undefined;
}

/** The origin a message carries, with the label that travels beside it. */
export function originFields(origin: MessageOrigin | undefined): { origin?: MessageOrigin; detail?: string } {
  return origin ? { origin, detail: originLabel(origin) } : {};
}

/** The label shown above a message: its origin's when it has one, else what was stored. */
export function messageLabel(message: { origin?: MessageOrigin; detail?: string }): string | undefined {
  return (message.origin && originLabel(message.origin)) ?? message.detail;
}

/** Where a message an older build labelled came from, read from the label it wrote. */
export function legacyOrigin(detail: string): MessageOrigin {
  if (detail === COORDINATION) return { kind: "coordination" };
  const run = AUTOMATION.exec(detail);
  if (run) return { kind: "automation", runNumber: Number(run[1]) };
  if (detail.startsWith(FROM)) {
    const sender = detail.slice(FROM.length);
    const end = sender.lastIndexOf(SEPARATOR);
    const threadId = end < 0 ? "" : sender.slice(end + SEPARATOR.length);
    return threadId && !/\s/.test(threadId)
      ? { kind: "thread", threadId, title: sender.slice(0, end) }
      : { kind: "thread", title: sender };
  }
  return { kind: "legacy", label: detail };
}

/**
 * A user message an older build stored or sent with only a label, given the origin that label names.
 * Anything else comes back as it was.
 */
export function withLegacyOrigin<T extends { kind?: string; origin?: MessageOrigin; detail?: string }>(message: T): T {
  if (message.origin || message.detail === undefined || (message.kind !== undefined && message.kind !== "user")) return message;
  return { ...message, origin: legacyOrigin(message.detail) };
}
