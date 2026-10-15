import { useEffect, useState } from "react";
import { MAX_COMMIT_CHECKS } from "../domain/message-artifacts";

/**
 * Whether a checkout holds a commit, asked once per hash. A reply can name a commit in a repository
 * other than its thread's, and only one the checkout holds has a diff to open.
 */
const held = new Map<string, boolean>();
/** A miss is asked again after a while, since a fetch can bring the commit in. */
const missedAt = new Map<string, number>();
const MISS_TTL_MS = 60_000;
/** Enough for every hash a long session shows, with the oldest forgotten first. */
const MAX_REMEMBERED = 2_000;

/** Hashes asked about in the same moment, gathered per checkout into one read. */
let queued = new Map<string, Map<string, Array<(answer: boolean) => void>>>();
let flushing = false;

const keyOf = (workspaceId: string, hash: string) => `${workspaceId}\u0000${hash}`;

function remembered(key: string) {
  const answer = held.get(key);
  if (answer === false && Date.now() - (missedAt.get(key) ?? 0) > MISS_TTL_MS) {
    held.delete(key);
    missedAt.delete(key);
    return undefined;
  }
  return answer;
}

function remember(key: string, answer: boolean) {
  held.delete(key);
  held.set(key, answer);
  if (!answer) missedAt.set(key, Date.now());
  for (const [oldest] of held) {
    if (held.size <= MAX_REMEMBERED) break;
    held.delete(oldest);
    missedAt.delete(oldest);
  }
}

function flush() {
  flushing = false;
  const batches = queued;
  queued = new Map();
  for (const [workspaceId, waiting] of batches) {
    const hashes = [...waiting.keys()];
    for (let start = 0; start < hashes.length; start += MAX_COMMIT_CHECKS) {
      const chunk = hashes.slice(start, start + MAX_COMMIT_CHECKS);
      /** A checkout that cannot answer is asked again next time rather than remembered as lacking them. */
      void window.desktop.commits(workspaceId, chunk).then((found) => new Set(found), () => null).then((found) => {
        for (const hash of chunk) {
          const answer = found?.has(hash) ?? false;
          if (found) remember(keyOf(workspaceId, hash), answer);
          for (const settle of waiting.get(hash) ?? []) settle(answer);
        }
      });
    }
  }
}

function ask(workspaceId: string, hash: string) {
  return new Promise<boolean>((settle) => {
    const waiting = queued.get(workspaceId) ?? new Map<string, Array<(answer: boolean) => void>>();
    queued.set(workspaceId, waiting);
    waiting.set(hash, [...(waiting.get(hash) ?? []), settle]);
    if (!flushing) {
      flushing = true;
      queueMicrotask(flush);
    }
  });
}

/** True once the checkout is known to hold the commit; false while asking and when it does not. */
export function useKnownCommit(workspaceId: string | undefined, hash: string | null) {
  const key = workspaceId && hash ? keyOf(workspaceId, hash.toLowerCase()) : null;
  const [answer, setAnswer] = useState(() => key !== null && remembered(key) === true);
  useEffect(() => {
    const known = key ? remembered(key) : false;
    if (known !== undefined || !workspaceId || !hash) {
      setAnswer(known === true);
      return;
    }
    let live = true;
    void ask(workspaceId, hash.toLowerCase()).then((found) => { if (live) setAnswer(found); });
    return () => { live = false; };
  }, [key]);
  return answer;
}
