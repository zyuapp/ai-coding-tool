import type { ConversationMessage } from "./conversation.js";

type History = ConversationMessage[];
type Change = { previous: WeakRef<History>; from: number };

const changes = new WeakMap<History, Change>();
const MAX_ANCESTORS = 256;

/** Adds committed messages while recording the unchanged prefix for incremental persistence. */
export function appendMessages(before: History, added: History): History {
  if (!added.length) return before;
  const next = [...before, ...added];
  changes.set(next, { previous: new WeakRef(before), from: before.length });
  return next;
}

/** Replaces the committed tail, keeping every earlier message unchanged. */
export function replaceLastMessage(before: History, message: ConversationMessage): History {
  if (before.at(-1) === message) return before;
  const next = before.slice(0, -1);
  next.push(message);
  changes.set(next, { previous: new WeakRef(before), from: Math.max(0, before.length - 1) });
  return next;
}

/** Withdraws the suffix emitted by a quiet run while keeping earlier history intact. */
export function withdrawMessages(before: History, from: number): History {
  const next = [...before];
  for (let index = from; index < next.length; index += 1) {
    const message = next[index]!;
    if (!message.withdrawn) next[index] = { ...message, withdrawn: true };
  }
  changes.set(next, { previous: new WeakRef(before), from });
  return next;
}

/** Unknown or collected ancestry requires comparing from the beginning. */
export function firstChangedMessage(before: History | undefined, next: History): number {
  if (!before) return 0;
  if (before === next) return next.length;
  let current = next;
  let from = next.length;
  for (let visited = 0; visited < MAX_ANCESTORS; visited += 1) {
    const change = changes.get(current);
    if (!change) return 0;
    from = Math.min(from, change.from);
    const previous = change.previous.deref();
    if (previous === before) return from;
    if (!previous) return 0;
    current = previous;
  }
  return 0;
}
