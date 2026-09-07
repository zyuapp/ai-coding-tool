import type { WorkspacePatch, WorkspaceSplice } from "../contracts/workspace-runtime.js";

function container(value: unknown): value is Record<string, unknown> | unknown[] {
  return value !== null && typeof value === "object" && (Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype);
}

/** Shared references cost nothing; only changed branches cross the process boundary. */
export function workspacePatches(previous: unknown, next: unknown, path: Array<string | number> = []): WorkspacePatch[] {
  if (Object.is(previous, next)) return [];
  if (!container(previous) || !container(next) || Array.isArray(previous) !== Array.isArray(next)) return [{ path, value: next }];
  const patches: WorkspacePatch[] = [];
  if (Array.isArray(previous) && Array.isArray(next)) {
    let prefix = 0;
    while (prefix < previous.length && prefix < next.length && Object.is(previous[prefix], next[prefix])) prefix++;
    let suffix = 0;
    while (suffix < previous.length - prefix && suffix < next.length - prefix && Object.is(previous[previous.length - suffix - 1], next[next.length - suffix - 1])) suffix++;
    if (previous.length !== next.length) {
      return [{ path, splice: { index: prefix, deleteCount: previous.length - prefix - suffix, items: next.slice(prefix, next.length - suffix) } }];
    }
    for (let index = prefix; index < next.length - suffix; index++) {
      patches.push(...workspacePatches(previous[index], next[index], [...path, index]));
    }
    return patches;
  }
  const before = previous as Record<string, unknown>;
  const after = next as Record<string, unknown>;
  for (const key of Object.keys(after)) {
    if (!Object.hasOwn(before, key)) patches.push({ path: [...path, key], value: after[key] });
    else patches.push(...workspacePatches(before[key], after[key], [...path, key]));
  }
  for (const key of Object.keys(before)) if (!Object.hasOwn(after, key)) patches.push({ path: [...path, key], remove: true });
  return patches;
}

/** Copies each changed branch once while keeping unrelated selectors' references stable. */
export function applyWorkspacePatches<T>(state: T, patches: WorkspacePatch[]): T {
  let result: unknown = state;
  const copies = new WeakMap<object, Record<string, unknown> | unknown[]>();
  function writable(value: unknown): Record<string, unknown> {
    if (!container(value)) throw new Error("Invalid workspace patch path.");
    const held = copies.get(value);
    if (held) return held as Record<string, unknown>;
    const copy = Array.isArray(value) ? value.slice() : { ...value };
    copies.set(value, copy);
    copies.set(copy, copy);
    return copy as Record<string, unknown>;
  }
  function spliced(value: unknown, operation: WorkspaceSplice) {
    const target = writable(value);
    const { index, deleteCount, items } = operation;
    if (!Array.isArray(target) || !Number.isSafeInteger(index) || !Number.isSafeInteger(deleteCount)
      || index < 0 || index > target.length || deleteCount < 0 || deleteCount > target.length - index || !Array.isArray(items)) {
      throw new Error("Invalid workspace array splice.");
    }
    const oldLength = target.length;
    const newLength = oldLength - deleteCount + items.length;
    target.length = Math.max(oldLength, newLength);
    target.copyWithin(index + items.length, index + deleteCount, oldLength);
    for (let offset = 0; offset < items.length; offset++) target[index + offset] = items[offset];
    target.length = newLength;
    return target;
  }
  for (const patch of patches) {
    if (!patch.path.length) {
      result = "splice" in patch ? spliced(result, patch.splice) : patch.value;
      continue;
    }
    let parent = writable(result);
    result = parent;
    for (const segment of patch.path.slice(0, -1)) {
      if (segment === "__proto__" || !Object.hasOwn(parent, segment)) throw new Error("Invalid workspace patch key.");
      const child = writable(parent[segment]);
      parent[segment] = child;
      parent = child;
    }
    const key = patch.path.at(-1)!;
    if (key === "__proto__") throw new Error("Invalid workspace patch key.");
    if ("splice" in patch) {
      if (!Object.hasOwn(parent, key)) throw new Error("Invalid workspace patch key.");
      parent[key] = spliced(parent[key], patch.splice);
    } else if (patch.remove) delete parent[key];
    else parent[key] = patch.value;
  }
  return result as T;
}
