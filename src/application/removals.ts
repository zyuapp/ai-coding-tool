/** A record or list without some of its entries, or the same one when none of them is there. */

export function withoutThreadKeys<T>(record: Record<string, T>, removed: Set<string>): Record<string, T> {
  let cleaned: Record<string, T> | null = null;
  for (const threadId of removed) {
    if (!Object.hasOwn(record, threadId)) continue;
    cleaned ??= { ...record };
    delete cleaned[threadId];
  }
  return cleaned ?? record;
}

export function withoutMatchingValues<T>(record: Record<string, T>, matches: (value: T) => boolean): Record<string, T> {
  let cleaned: Record<string, T> | null = null;
  for (const key in record) {
    if (!matches(record[key]!)) continue;
    cleaned ??= { ...record };
    delete cleaned[key];
  }
  return cleaned ?? record;
}

export function withoutMatching<T>(items: T[], matches: (item: T) => boolean): T[] {
  const first = items.findIndex(matches);
  if (first === -1) return items;
  const kept = items.slice(0, first);
  for (let index = first + 1; index < items.length; index += 1) {
    if (!matches(items[index]!)) kept.push(items[index]!);
  }
  return kept;
}
